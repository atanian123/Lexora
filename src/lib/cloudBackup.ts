export interface CloudBackupFile {
  id: string;
  name: string;
  modifiedTime: string;
  size?: string;
}

export interface CloudBackupProvider {
  readonly id: "google-drive";
  readonly name: string;
  isConfigured(): boolean;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): void;
  listBackups(folderPath: string): Promise<CloudBackupFile[]>;
  uploadBackup(folderPath: string, filename: string, contents: string): Promise<void>;
  downloadBackup(fileId: string): Promise<string>;
  deleteBackup(fileId: string): Promise<void>;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface GoogleTokenClient {
  callback?: (response: GoogleTokenResponse) => void;
  requestAccessToken(options?: { prompt?: string }): void;
}

interface GoogleNonOAuthError {
  type?: string;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(options: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
            error_callback?: (error: GoogleNonOAuthError) => void;
          }): GoogleTokenClient;
        };
      };
    };
  }
}

const googleIdentityScriptUrl = "https://accounts.google.com/gsi/client";
const googleDriveApiBaseUrl = "https://www.googleapis.com/drive/v3";
const googleDriveUploadBaseUrl = "https://www.googleapis.com/upload/drive/v3";
const driveFolderMimeType = "application/vnd.google-apps.folder";
const backupMimeType = "application/json";
const googleDriveScope = "https://www.googleapis.com/auth/drive.file";
export const cloudBackupAuthorizationStorageKey = "lexora.cloud.googleDriveAuthorized";

let googleIdentityScriptPromise: Promise<void> | null = null;

export function createGoogleDriveBackupProvider(clientId: string | undefined): CloudBackupProvider {
  return new GoogleDriveBackupProvider(clientId?.trim() ?? "");
}

class GoogleDriveBackupProvider implements CloudBackupProvider {
  readonly id = "google-drive" as const;
  readonly name = "Google Drive";
  private tokenClient: GoogleTokenClient | null = null;
  private accessToken = "";
  private tokenExpiresAt = 0;
  private activeAuthFailure: ((error: GoogleNonOAuthError) => void) | null = null;

  constructor(private readonly clientId: string) {}

  isConfigured(): boolean {
    return Boolean(this.clientId);
  }

  isConnected(): boolean {
    return Boolean(this.accessToken) && Date.now() < this.tokenExpiresAt - 30_000;
  }

  async connect(): Promise<void> {
    if (!this.clientId) {
      throw new Error("missing-client-id");
    }

    await loadGoogleIdentityScript();
    const tokenClient = await this.getTokenClient();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        reject(new Error("google-auth-timeout"));
      }, 120_000);
      const finish = (action: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        this.activeAuthFailure = null;
        action();
      };

      this.activeAuthFailure = (error) => {
        this.disconnect();
        finish(() => reject(new Error(error.type || "google-auth-cancelled")));
      };

      tokenClient.callback = (response) => {
        if (response.error || !response.access_token) {
          this.disconnect();
          finish(() => reject(new Error(response.error || "google-auth-failed")));
          return;
        }

        this.accessToken = response.access_token;
        this.tokenExpiresAt = Date.now() + (response.expires_in ?? 3600) * 1000;
        localStorage.setItem(cloudBackupAuthorizationStorageKey, "true");
        finish(resolve);
      };
      const hasPreviousAuthorization = localStorage.getItem(cloudBackupAuthorizationStorageKey) === "true";
      tokenClient.requestAccessToken({ prompt: this.accessToken || hasPreviousAuthorization ? "" : "consent" });
    });
  }

  disconnect(): void {
    this.accessToken = "";
    this.tokenExpiresAt = 0;
    localStorage.removeItem(cloudBackupAuthorizationStorageKey);
  }

  async listBackups(folderPath: string): Promise<CloudBackupFile[]> {
    const folderId = await this.ensureFolderPath(folderPath);
    const query = [
      `'${folderId}' in parents`,
      "trashed = false",
      "mimeType = 'application/json'",
      "name contains 'lexora-backup-'"
    ].join(" and ");
    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name,modifiedTime,size)",
      orderBy: "modifiedTime desc",
      pageSize: "50"
    });
    const response = await this.driveFetch<{ files?: CloudBackupFile[] }>(`${googleDriveApiBaseUrl}/files?${params}`);
    return response.files ?? [];
  }

  async uploadBackup(folderPath: string, filename: string, contents: string): Promise<void> {
    const folderId = await this.ensureFolderPath(folderPath);
    const existing = await this.findChild(folderId, filename, backupMimeType);
    const metadata = {
      name: filename,
      mimeType: backupMimeType,
      parents: existing ? undefined : [folderId]
    };
    const formData = new FormData();
    formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    formData.append("file", new Blob([contents], { type: backupMimeType }));

    const url = existing
      ? `${googleDriveUploadBaseUrl}/files/${existing.id}?uploadType=multipart`
      : `${googleDriveUploadBaseUrl}/files?uploadType=multipart`;
    await this.driveFetch(url, {
      method: existing ? "PATCH" : "POST",
      body: formData
    });
  }

  async downloadBackup(fileId: string): Promise<string> {
    return this.driveFetchText(`${googleDriveApiBaseUrl}/files/${encodeURIComponent(fileId)}?alt=media`);
  }

  async deleteBackup(fileId: string): Promise<void> {
    await this.driveFetch(`${googleDriveApiBaseUrl}/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
  }

  private async getTokenClient(): Promise<GoogleTokenClient> {
    if (this.tokenClient) {
      return this.tokenClient;
    }

    const initTokenClient = window.google?.accounts?.oauth2?.initTokenClient;
    if (!initTokenClient) {
      throw new Error("google-identity-unavailable");
    }

    this.tokenClient = initTokenClient({
      client_id: this.clientId,
      scope: googleDriveScope,
      callback: () => undefined,
      error_callback: (error) => {
        this.disconnect();
        this.activeAuthFailure?.(error);
      }
    });

    return this.tokenClient;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  private async ensureFolderPath(folderPath: string): Promise<string> {
    await this.ensureConnected();

    const segments = normalizeFolderPath(folderPath);
    let parentId = "root";
    for (const segment of segments) {
      const existing = await this.findChild(parentId, segment, driveFolderMimeType);
      if (existing) {
        parentId = existing.id;
        continue;
      }

      const created = await this.driveFetch<{ id: string }>(`${googleDriveApiBaseUrl}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: segment,
          mimeType: driveFolderMimeType,
          parents: parentId === "root" ? undefined : [parentId]
        })
      });
      parentId = created.id;
    }

    return parentId;
  }

  private async findChild(parentId: string, name: string, mimeType: string): Promise<{ id: string } | undefined> {
    const query = [
      parentId === "root" ? "'root' in parents" : `'${parentId}' in parents`,
      `name = '${escapeDriveQueryValue(name)}'`,
      `mimeType = '${mimeType}'`,
      "trashed = false"
    ].join(" and ");
    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name)",
      pageSize: "1"
    });
    const response = await this.driveFetch<{ files?: Array<{ id: string }> }>(`${googleDriveApiBaseUrl}/files?${params}`);
    return response.files?.[0];
  }

  private async driveFetch<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.authorizedFetch(url, init);
    if (!response.ok) {
      throw new Error(`google-drive-${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private async driveFetchText(url: string): Promise<string> {
    const response = await this.authorizedFetch(url);
    if (!response.ok) {
      throw new Error(`google-drive-${response.status}`);
    }

    return response.text();
  }

  private async authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureConnected();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);

    return fetch(url, {
      ...init,
      headers
    });
  }
}

function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve();
  }

  if (googleIdentityScriptPromise) {
    return googleIdentityScriptPromise;
  }

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${googleIdentityScriptUrl}"]`);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("google-identity-load-failed")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = googleIdentityScriptUrl;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("google-identity-load-failed"));
    document.head.append(script);
  });

  return googleIdentityScriptPromise;
}

function normalizeFolderPath(folderPath: string): string[] {
  const segments = folderPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length > 0 ? segments : ["Lexora", "Backups"];
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
