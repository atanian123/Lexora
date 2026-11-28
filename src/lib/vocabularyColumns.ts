import type { Page } from "tesseract.js";

interface Column {
  left: number;
  right: number;
}

interface PrintedLine {
  x: number;
  y: number;
  text: string;
}

export async function recognizeVocabularyColumns(
  image: ImageData,
  recognizeColumn: (canvas: HTMLCanvasElement, index: 0 | 1) => Promise<Page>
) {
  const ink = normalizePaper(image);
  const columns = findColumns(ink, image.width, image.height);
  if (!columns) return;

  const left = await readColumn(image, ink, columns[0], (canvas) => recognizeColumn(canvas, 0));
  const right = await readColumn(image, ink, columns[1], (canvas) => recognizeColumn(canvas, 1));
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

function findColumns(ink: Uint8Array, width: number, height: number) {
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
  const content = bands.filter(({ left, right }) => right - left >= width * 0.06);
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

async function readColumn(
  { width, height }: ImageData,
  ink: Uint8Array,
  column: Column,
  recognize: (canvas: HTMLCanvasElement) => Promise<Page>
): Promise<PrintedLine[]> {
  const crop = document.createElement("canvas");
  const sheet = document.createElement("canvas");
  const padding = 8;
  crop.width = column.right - column.left + padding * 2;
  crop.height = height + padding * 2;
  const scale = Math.min(2, 3000 / Math.max(crop.width, crop.height));
  sheet.width = Math.round(crop.width * scale);
  sheet.height = Math.round(crop.height * scale);
  try {
    const context = crop.getContext("2d", { alpha: false });
    const sheetContext = sheet.getContext("2d", { alpha: false });
    if (!context || !sheetContext) return [];
    const image = context.createImageData(crop.width, crop.height);
    image.data.fill(255);
    for (let y = 0; y < height; y += 1) {
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
    return lines.flatMap(({ bbox, text, confidence }) => {
      const value = text.trim().replace(/\s+/g, " ");
      const touchesEdge = bbox.y0 / scaleY <= padding + 1 || bbox.y1 / scaleY >= padding + height - 1;
      // Fragments cut off by the frame can show up as a continuation of the last word.
      if ((touchesEdge && confidence < 30) || !/[\p{L}\p{N}]/u.test(value)) return [];
      return [{ x: bbox.x0 / scaleX, y: (bbox.y0 + bbox.y1) / (2 * scaleY), text: value }];
    }).sort((a, b) => a.y - b.y);
  } finally {
    crop.width = crop.height = sheet.width = sheet.height = 0;
  }
}

type Pair = [PrintedLine | undefined, PrintedLine | undefined];

function followsWithIndent(line: PrintedLine, start: PrintedLine, spacing: number) {
  return line.x - start.x >= spacing * 0.3 && line.y - start.y <= spacing * 1.25;
}

function alignColumns(left: PrintedLine[], right: PrintedLine[], separation: number) {
  if (left.length < 3 || right.length < 3) return;
  const gaps = [left, right].flatMap((lines) => lines.slice(1).map(({ y }, i) => y - lines[i].y));
  gaps.sort((a, b) => a - b);
  const spacing = gaps[Math.floor(gaps.length / 2)];
  const tolerance = spacing * 0.38;
  if (tolerance <= 0) return;

  // Wrapped lines may still be paired when the geometry fits, but should not pull the row alignment away from the cell starts.
  const continuations = new Set<PrintedLine>();
  for (const lines of [left, right]) {
    let start = lines[0];
    for (const line of lines.slice(1)) {
      if (followsWithIndent(line, start, spacing)) {
        continuations.add(line);
        start = { ...start, y: line.y };
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
  if (best.matched < 3) return;

  const rows: Array<{ first: string; second: string }> = [];
  let previous: Pair = [undefined, undefined];
  for (const [first, second] of best.pairs) {
    if (first && second) {
      rows.push({ first: first.text, second: second.text });
      previous = [first, second];
      continue;
    }
    const side = first ? 0 : 1;
    const line = first ?? second;
    const start = previous[side];
    const row = rows[rows.length - 1];
    const key = side === 0 ? "first" : "second";
    if (row && start && line && followsWithIndent(line, start, spacing)) {
      row[key] += ` ${line.text}`;
      // Keep the original indent and measure the next continuation from the latest line.
      previous[side] = { ...start, y: line.y };
    } else {
      rows.push({ first: first?.text ?? "", second: second?.text ?? "" });
      previous = [first, second];
    }
  }
  // A wrapped cell may contain several printed lines. Assess the matches after joining them.
  if (best.matched >= rows.length * 0.6) return rows;
}
