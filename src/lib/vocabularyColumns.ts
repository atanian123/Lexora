import type { Page } from "tesseract.js";

interface Column {
  left: number;
  right: number;
}

interface PrintedLine {
  x: number;
  y: number;
  text: string;
  clipped?: boolean;
}

export interface RecognizedPair {
  first: string;
  second: string;
  firstClipped?: boolean;
  secondClipped?: boolean;
}

const doubleQuote = /["“”„«»]/u;
const sentenceEnd = /[.!?…]["”’»)\]]*$/u;
const numberedTitle = /^\d{1,3}[.):\s-]+\p{Lu}[\p{L}\p{M}-]*(?:\s+[\p{L}\p{M}-]+)+$/u;

export async function recognizeVocabularyColumns(
  image: ImageData,
  recognizeColumn: (canvas: HTMLCanvasElement, index: 0 | 1) => Promise<Page>,
  recognizeLine: (canvas: HTMLCanvasElement, index: 0 | 1, mixed: boolean) => Promise<Page>,
  mixedColumn?: 0 | 1
) {
  const ink = normalizePaper(image);
  const page = findVocabularyPage(ink, image.width, image.height);
  if (!page) return;
  const { columns, bottom } = page;

  const read = (index: 0 | 1) => readColumn(image, ink, columns[index], bottom,
    (canvas) => recognizeColumn(canvas, index), (canvas, mixed) => recognizeLine(canvas, index, mixed), mixedColumn === index);
  const left = await read(0);
  const right = await read(1);
  return alignColumns(left, right, columns[1].left - columns[0].left);
}

function normalizePaper({ width, height, data }: ImageData) {
  const stride = width + 1;
  const sums = new Uint32Array(stride * (height + 1));
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const offset = i * 4;
      const gray = (data[offset] * 3 + data[offset + 1] * 6 + data[offset + 2]) / 10;
      ink[i] = gray;
      rowSum += ink[i];
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + rowSum;
    }
  }

  // Compare with nearby paper so uneven lighting and faint print from the back carry less weight.
  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.024));
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const sum = sums[bottom * stride + right] - sums[bottom * stride + left] -
        sums[top * stride + right] + sums[top * stride + left];
      const contrast = sum / ((bottom - top) * (right - left)) - ink[y * width + x];
      ink[y * width + x] = Math.min(255, Math.max(0, (contrast - 14) * 5));
    }
  }
  return ink;
}

export function findColumns(ink: Uint8Array, width: number, height: number) {
  const projection = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    let rule = false;
    for (let x = 0; x < width; x += 1) {
      run = ink[y * width + x] >= 80 ? run + 1 : 0;
      if (run > width * 0.42) {
        rule = true;
        break;
      }
    }
    // Rules can bridge the gutter. Keep rows whose ink is broken into individual letters.
    if (rule) {
      ink.fill(0, y * width, (y + 1) * width);
      continue;
    }
    for (let x = 0; x < width; x += 1) {
      if (ink[y * width + x] >= 80) projection[x] += 1;
    }
  }

  const bands: Column[] = [];
  for (let x = 0; x < width; x += 1) {
    if (projection[x] < Math.max(2, height * 0.003)) continue;
    const band = bands[bands.length - 1];
    if (band && x - band.right <= width * 0.014) band.right = x + 1;
    else bands.push({ left: x, right: x + 1 });
  }

  // A narrow mark at the edge, such as a workbook rule, is too small to be a column.
  let content = bands.filter(({ left, right }) => right - left >= width * 0.06);
  if (content.length > 2) {
    // A curved page rule and a sliver of the next page can be wide enough to look like a column.
    // Its ink is sparse compared with the two text columns. Keep its bounds when padding the crops.
    const inkCounts = content.map(({ left, right }) => projection.slice(left, right).reduce((total, count) => total + count, 0));
    const strongest = Math.max(...inkCounts);
    content = content.filter(({ left, right }, i) => {
      const atEdge = left <= width * 0.02 || right >= width * 0.98;
      return !atEdge || right - left >= width * 0.12 || inkCounts[i] >= strongest * 0.25;
    });
  }
  if (content.length !== 2) return;
  const [first, second] = content;
  const gap = second.left - first.right;
  if (gap < width * 0.035 || bands.indexOf(second) - bands.indexOf(first) !== 1) return;

  return [first, second].map((column) => {
    const index = bands.indexOf(column);
    const padding = Math.max(3, Math.round(width * 0.018));
    return {
      left: Math.max(column.left - padding, bands[index - 1]?.right ?? 0),
      right: Math.min(column.right + padding, bands[index + 1]?.left ?? width)
    };
  });
}

export function findVocabularyPage(ink: Uint8Array, width: number, height: number) {
  const columns = findColumns(ink, width, height);
  if (columns) return { columns, bottom: height };

  // A lower strip of fabric or desktop can fill the gutter in the full-height projection.
  // Try the region above it only when a blank margin separates it from two text columns.
  const marginHeight = Math.max(20, Math.round(height * 0.055));
  const inset = Math.round(width * 0.04);
  let blankStart = Math.floor(height / 2);
  for (let y = blankStart; y < height - marginHeight; y += 1) {
    let pixels = 0;
    for (let x = inset; x < width - inset; x += 1) {
      if (ink[y * width + x] >= 80) pixels += 1;
    }
    if (pixels <= width * 0.005) continue;
    const blankHeight = y - blankStart;
    blankStart = y + 1;
    if (blankHeight < marginHeight) continue;

    const prefix = findColumns(ink, width, y);
    if (!prefix) continue;
    const gutterStart = prefix[0].right;
    const gutterEnd = prefix[1].left;
    const minimumInk = Math.max(3, (height - y) * 0.02);
    let wide = 0;
    let gutter = 0;
    for (let x = 0; x < width; x += 1) {
      let count = 0;
      for (let row = y; row < height && count < minimumInk; row += 1) {
        if (ink[row * width + x] >= 80) count += 1;
      }
      if (count < minimumInk) continue;
      wide += 1;
      if (x >= gutterStart && x < gutterEnd) gutter += 1;
    }
    if (wide >= width * 0.8 && gutter >= (gutterEnd - gutterStart) * 0.6) return { columns: prefix, bottom: y };
  }
}

async function readColumn(
  original: ImageData,
  ink: Uint8Array,
  column: Column,
  pageBottom: number,
  recognize: (canvas: HTMLCanvasElement) => Promise<Page>,
  recognizeLine: (canvas: HTMLCanvasElement, mixed: boolean) => Promise<Page>,
  mayContainMixedText: boolean
): Promise<PrintedLine[]> {
  const { width, height } = original;
  const crop = document.createElement("canvas");
  const sheet = document.createElement("canvas");
  const padding = 8;
  crop.width = column.right - column.left + padding * 2;
  crop.height = pageBottom + padding * 2;
  const scale = Math.min(2, 3000 / Math.max(crop.width, crop.height));
  sheet.width = Math.round(crop.width * scale);
  sheet.height = Math.round(crop.height * scale);
  try {
    const context = crop.getContext("2d", { alpha: false });
    const sheetContext = sheet.getContext("2d", { alpha: false });
    if (!context || !sheetContext) return [];
    const image = context.createImageData(crop.width, crop.height);
    image.data.fill(255);
    for (let y = 0; y < pageBottom; y += 1) {
      for (let x = column.left; x < column.right; x += 1) {
        const shade = 255 - ink[y * width + x];
        const offset = ((y + padding) * crop.width + x - column.left + padding) * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = shade;
      }
    }
    context.putImageData(image, 0, 0);
    sheetContext.imageSmoothingQuality = "high";
    sheetContext.drawImage(crop, 0, 0, sheet.width, sheet.height);
    const data = await recognize(sheet);
    const lines = data.blocks?.flatMap(({ paragraphs }) => paragraphs.flatMap(({ lines }) => lines)) ?? [];
    const scaleY = sheet.height / crop.height;
    const scaleX = sheet.width / crop.width;
    const result: PrintedLine[] = [];
    let retries = 0;
    for (const { bbox, text, confidence } of lines) {
      let value = text.trim().replace(/[ \t]{4,}[-–—_|]+$/u, "").replace(/\s+/g, " ");
      const touchesEdge = bbox.y0 / scaleY <= padding + 1 || bbox.y1 / scaleY >= padding + height - 1;
      // Fragments cut off by the frame can show up as a continuation of the last word.
      if ((touchesEdge && confidence < 30) || !/[\p{L}\p{N}]/u.test(value)) continue;
      const mixed = mayContainMixedText && confidence < 85 && doubleQuote.test(value);
      if (!touchesEdge && retries < 5 && (mixed || confidence < 35)) {
        retries += 1;
        // Faint strokes can disappear when flattening shadows. Re-read the original pixels for this line.
        const left = Math.max(column.left, Math.floor(column.left + (bbox.x0 - 12) / scaleX - padding));
        const right = Math.min(column.right, Math.ceil(column.left + (bbox.x1 + 12) / scaleX - padding));
        const top = Math.max(0, Math.floor((bbox.y0 - 5) / scaleY - padding));
        const bottom = Math.min(pageBottom, Math.ceil((bbox.y1 + 5) / scaleY - padding));
        crop.width = right - left;
        crop.height = bottom - top;
        context.putImageData(original, -left, -top, left, top, crop.width, crop.height);
        sheet.width = Math.round(crop.width * scaleX);
        sheet.height = Math.round(crop.height * scaleY);
        sheetContext.imageSmoothingQuality = "high";
        sheetContext.drawImage(crop, 0, 0, sheet.width, sheet.height);
        const retry = await recognizeLine(sheet, mixed);
        const candidate = retry.text.trim().replace(/\s+/g, " ");
        const mixedScripts = /\p{Script=Latin}/u.test(candidate) && /\p{Script=Cyrillic}/u.test(candidate);
        if (retry.confidence >= confidence + (mixed ? 3 : 12) && /\p{L}/u.test(candidate) && (!mixed || mixedScripts)) {
          const openingQuote = doubleQuote.test(value[0]) && !doubleQuote.test(candidate[0]) ? value[0] : "";
          value = openingQuote + candidate;
        }
      }
      result.push({ x: bbox.x0 / scaleX, y: (bbox.y0 + bbox.y1) / (2 * scaleY), text: value, clipped: touchesEdge });
    }
    return result.sort((a, b) => a.y - b.y);
  } finally {
    crop.width = crop.height = sheet.width = sheet.height = 0;
  }
}

type Pair = [PrintedLine | undefined, PrintedLine | undefined];

function followsWithinEntry(line: PrintedLine, previous: PrintedLine, spacing: number, wrapGap: number) {
  const gap = line.y - previous.y;
  const indent = line.x - previous.x;
  if (gap <= 0 || gap > spacing * 1.25 || /^[¿¡•]|^\d+[.)]\s/u.test(line.text)) return false;
  const continuesNote = previous.text.lastIndexOf("(") > previous.text.lastIndexOf(")") ||
    previous.text.lastIndexOf("[") > previous.text.lastIndexOf("]") || line.text.startsWith("(") || line.text.startsWith("[");
  if (sentenceEnd.test(previous.text) && !continuesNote && !previous.clipped) return false;
  if (indent >= spacing * 0.3) return true;
  if (indent <= -spacing * 0.3) return false;

  // Some pages wrap flush with the left edge. Closer line spacing or open punctuation can indicate the same entry.
  return gap < wrapGap || continuesNote || (/^[¿¡]/u.test(previous.text) && !/[?!]/u.test(previous.text));
}

function isWrappedSentence(lines: PrintedLine[]) {
  if (lines.length < 2 || !/^[¿¡\p{Lu}]/u.test(lines[0].text) || !sentenceEnd.test(lines[lines.length - 1].text)) return false;
  return lines.slice(1).every((line, index) => /^\p{Ll}/u.test(line.text) && !sentenceEnd.test(lines[index].text));
}

function markWrappedSentences(lines: PrintedLine[], minimumGap: number, wrapped: Set<PrintedLine>) {
  let start = 0;
  for (let end = 1; end <= lines.length; end += 1) {
    if (end < lines.length && lines[end].y - lines[end - 1].y < minimumGap) continue;
    const block = lines.slice(start, end);
    if (isWrappedSentence(block)) {
      for (const line of block.slice(1)) wrapped.add(line);
    }
    start = end;
  }
}

export function alignColumns(left: PrintedLine[], right: PrintedLine[], separation: number) {
  if (!left.length || !right.length) return;
  const columnGaps = [left, right].filter((lines) => lines.length > 1)
    .map((lines) => lines.slice(1).map(({ y }, i) => y - lines[i].y).sort((a, b) => a - b));
  const gaps = columnGaps.flat().sort((a, b) => a - b);
  // Prefer the shorter gap when there are equally many text lines and section breaks.
  const spacing = gaps[Math.floor((gaps.length - 1) / 2)];
  // A large gap can be a section break. Apply wider spacing only inside blocks that read as wrapped sentences.
  const sharedRowSpacing = Math.min(...columnGaps.map((values) => values[Math.floor(values.length * 0.8)]));
  const tolerance = spacing * 0.38;
  if (!(tolerance > 0)) return;
  const wrappedSentences = new Set<PrintedLine>();
  if (sharedRowSpacing > spacing) {
    for (const lines of [left, right]) markWrappedSentences(lines, sharedRowSpacing * 0.9, wrappedSentences);
  }
  const wrapGap = (line: PrintedLine) => (wrappedSentences.has(line) ? sharedRowSpacing : spacing) * 0.72;
  const denserSide = left.length >= right.length * 2 ? 0 : right.length >= left.length * 2 ? 1 : undefined;

  // Wrapped lines may still be paired when the geometry fits, but should not pull the row alignment away from the cell starts.
  const continuations = new Set<PrintedLine>();
  for (const lines of [left, right]) {
    let start = lines[0];
    for (const line of lines.slice(1)) {
      if (followsWithinEntry(line, start, spacing, wrapGap(line))) {
        continuations.add(line);
        start = { ...start, y: line.y, text: `${start.text} ${line.text}` };
      } else {
        start = line;
      }
    }
  }

  function match(scale: number, offset: number) {
    const pairs: Pair[] = [];
    let score = 0;
    let matched = 0;
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      const error = left[i].y * scale + offset - right[j].y;
      if (Math.abs(error) <= tolerance) {
        if (!continuations.has(left[i]) && !continuations.has(right[j])) score += 1 - 0.5 * (error / tolerance) ** 2;
        pairs.push([left[i++], right[j++]]);
        matched += 1;
      } else if (error < 0) {
        pairs.push([left[i++], undefined]);
      } else {
        pairs.push([undefined, right[j++]]);
      }
    }
    for (; i < left.length; i += 1) pairs.push([left[i], undefined]);
    for (; j < right.length; j += 1) pairs.push([undefined, right[j]]);
    return { pairs, score, matched };
  }

  // The vertical offset between columns can change down a tilted or perspective-distorted page.
  // Try starts and ends near the edges without assuming every line has a partner.
  let best = match(1, 0);
  const maxShift = Math.max(spacing * 0.75, separation * 0.2);
  for (const start of left.slice(0, 3)) {
    for (const otherStart of right.slice(0, 3)) {
      if (Math.abs(start.y - otherStart.y) > maxShift) continue;
      for (const end of left.slice(-3)) {
        if (end.y <= start.y) continue;
        for (const otherEnd of right.slice(-3)) {
          if (Math.abs(end.y - otherEnd.y) > maxShift) continue;
          const scale = (otherEnd.y - otherStart.y) / (end.y - start.y);
          if (Math.abs(scale - 1) > 0.2) continue;
          const result = match(scale, otherStart.y - start.y * scale);
          // Prefer the smaller shift when two interpretations match nearly the same rows.
          result.score -= 0.2 * (Math.abs(start.y - otherStart.y) + Math.abs(end.y - otherEnd.y)) / spacing;
          if (result.score > best.score) best = result;
        }
      }
    }
  }
  if (!best.matched) return;

  const rows: RecognizedPair[] = [];
  let previous: Pair = [undefined, undefined];
  let previousAligned: Pair | undefined;
  let pairedRows = 0;
  for (const [index, pair] of best.pairs.entries()) {
    const [first, second] = pair;
    if (first && second) {
      previousAligned = pair;
    } else {
      const side = first ? 0 : 1;
      const line = pair[side];
      if (line && numberedTitle.test(line.text)) {
        const prior = previousAligned?.[side];
        const next = best.pairs.slice(index + 1).find(([leftLine, rightLine]) => leftLine && rightLine)?.[side];
        if (next && next.y - line.y >= spacing * 1.5 && (!prior || line.y - prior.y >= spacing * 1.5)) continue;
      }
    }

    const row = rows[rows.length - 1];
    const wrapped = row && pair.every((line, side) => {
      const start = previous[side];
      if (!line) return true;
      if (!start) return false;
      if (followsWithinEntry(line, start, spacing, wrapGap(line))) return true;
      // A much denser column can wrap at the same pitch as the next entry. An unmatched continuation
      // after an unfinished phrase in a complete pair provides an additional cue on these pages.
      const gap = line.y - start.y;
      return side === denserSide && !(first && second) && Boolean(row.first && row.second) &&
        gap > 0 && gap <= spacing * 1.25 && Math.abs(line.x - start.x) < spacing * 0.3 &&
        /\s/u.test(start.text) && !sentenceEnd.test(start.text) && /^\p{Ll}/u.test(line.text);
    });
    if (wrapped) {
      // The translations can wrap on the same physical line, so even a matched pair can continue a row.
      for (const side of [0, 1] as const) {
        const line = pair[side];
        const start = previous[side];
        if (!line || !start) continue;
        const key = side === 0 ? "first" : "second";
        row[key] += ` ${line.text}`;
        if (line.clipped) row[side === 0 ? "firstClipped" : "secondClipped"] = true;
        previous[side] = { ...start, y: line.y, text: row[key] };
      }
      continue;
    }
    const entry: RecognizedPair = { first: first?.text ?? "", second: second?.text ?? "" };
    if (first?.clipped) entry.firstClipped = true;
    if (second?.clipped) entry.secondClipped = true;
    rows.push(entry);
    previous = pair;
    if (first && second) pairedRows += 1;
  }
  // A wrapped cell may contain several printed lines. Assess the matches after joining them.
  const shortWrappedScan = pairedRows === rows.length && pairedRows < 3 && left.length + right.length > pairedRows * 2;
  if (shortWrappedScan || pairedRows >= Math.max(3, rows.length * 0.6)) return rows;
}
