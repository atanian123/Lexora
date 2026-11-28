import type { Page } from "tesseract.js";

interface Span {
  start: number;
  end: number;
}

interface CardLine {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

type RecognizeSheet = (sheet: HTMLCanvasElement, lineIndex: 0 | 1) => Promise<Page>;

export async function recognizeVocabularyCards(source: ImageData, includeSecondLine: boolean, recognizeSheet: RecognizeSheet) {
  const layout = findVocabularyCards(source);
  if (!layout) return;

  const { cards } = layout;
  const firstLines = cards.map(([first]) => first);
  const firstText = await recognizeCardLines(source.width, layout, firstLines, (sheet) => recognizeSheet(sheet, 0));
  const secondText = includeSecondLine
    ? await recognizeCardLines(source.width, layout, cards.flatMap(([, second]) => second ? [second] : []), (sheet) => recognizeSheet(sheet, 1))
    : undefined;

  const recognized = cards.map(([first, second]) => ({
    first: firstText.get(first) ?? "",
    second: second ? secondText?.get(second) ?? "" : ""
  })).filter(({ first, second }) => first || second);
  if (recognized.length) return recognized;
}

async function recognizeCardLines(
  sourceWidth: number,
  { ink, cardHeight }: { ink: Uint8Array; cardHeight: number },
  lines: CardLine[],
  recognizeSheet: (sheet: HTMLCanvasElement) => Promise<Page>
) {
  const textByLine = new Map<CardLine, string>();
  if (!lines.length) return textByLine;

  // Give each text line a white margin and keep its position so missing lines cannot shift later pairs.
  const padding = Math.max(10, Math.round(cardHeight * 0.08));
  const sheet = document.createElement("canvas");
  sheet.width = Math.max(...lines.map(({ right, left }) => right - left)) + padding * 2;
  sheet.height = lines.reduce((height, line) => height + line.bottom - line.top + padding, padding);

  try {
    const context = sheet.getContext("2d", { alpha: false });
    if (!context) return textByLine;
    const image = context.createImageData(sheet.width, sheet.height);
    image.data.fill(255);
    let top = padding;
    const positions = lines.map((line) => {
      const bottom = top + line.bottom - line.top;
      for (let y = line.top; y < line.bottom; y += 1) {
        for (let x = line.left; x < line.right; x += 1) {
          const shade = 255 - ink[y * sourceWidth + x];
          const offset = ((top + y - line.top) * sheet.width + padding + x - line.left) * 4;
          image.data.fill(shade, offset, offset + 3);
        }
      }
      const position = { line, top, bottom };
      top = bottom + padding;
      return position;
    });
    context.putImageData(image, 0, 0);

    const data = await recognizeSheet(sheet);
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const { bbox, text } of paragraph.lines) {
          const center = (bbox.y0 + bbox.y1) / 2;
          const position = positions.find(({ top, bottom }) => center >= top && center < bottom);
          const value = text.trim().replace(/\s+/g, " ");
          if (!position || !/\p{L}/u.test(value)) continue;
          const existing = textByLine.get(position.line);
          textByLine.set(position.line, existing ? `${existing} ${value}` : value);
        }
      }
    }

    return textByLine;
  } finally {
    sheet.width = sheet.height = 0;
  }
}

function findVocabularyCards({ width, height, data }: ImageData) {
  const brightness = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < brightness.length; i += 1) {
    const offset = i * 4;
    const value = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
    brightness[i] = value;
    histogram[brightness[i]] += 1;
  }

  const background = histogram.indexOf(Math.max(...histogram));
  const backgroundPixels = histogram.slice(Math.max(0, background - 8), background + 9)
    .reduce((total, count) => total + count, 0);
  // The high-contrast card pass is for screenshots with a largely flat dark background.
  if (background > 100 || backgroundPixels < brightness.length / 2) return;

  const dividers: Span[] = [];
  const middleLeft = Math.floor(width * 0.2);
  const middleRight = Math.ceil(width * 0.8);
  const dividerThreshold = background + 18;
  for (let y = 0; y < height; y += 1) {
    let brightPixels = 0;
    for (let x = middleLeft; x < middleRight; x += 1) {
      if (brightness[y * width + x] >= dividerThreshold) brightPixels += 1;
    }
    if (brightPixels >= (middleRight - middleLeft) * 0.95) addToSpans(dividers, y, 0);
  }

  const thinDividers = dividers.filter(({ start, end }) => end - start <= height * 0.025);
  if (thinDividers.length < 3) return;
  const gaps = thinDividers.slice(1).map((divider, i) => divider.start - thinDividers[i].start);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const cardHeight = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const regularGaps = gaps.filter((gap) => Math.abs(gap - cardHeight) < cardHeight * 0.2);
  if (cardHeight < 32 || regularGaps.length < Math.max(2, gaps.length * 0.75)) return;

  const middleDivider = thinDividers[Math.floor(thinDividers.length / 2)];
  const dividerRow = Math.floor((middleDivider.start + middleDivider.end) / 2) * width;
  let left = middleLeft;
  let right = middleRight - 1;
  while (left > 0 && brightness[dividerRow + left - 1] >= dividerThreshold) left -= 1;
  while (right < width - 1 && brightness[dividerRow + right + 1] >= dividerThreshold) right += 1;
  const inset = Math.max(3, Math.round(cardHeight * 0.055));
  left += inset;
  right -= inset;

  // Repeated colored controls can leave gray antialiasing on their edges.
  // Exclude their columns near the sides as well as the colored pixels themselves.
  const colorColumns = new Uint16Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = y * width + x;
      if (brightness[index] >= background + 35 && isColorful(data, index * 4)) colorColumns[x] += 1;
    }
  }
  const iconPadding = Math.max(3, Math.round(cardHeight * 0.04));
  const minimumColor = Math.max(3, height * 0.015);
  for (let x = middleLeft - 1; x >= left; x -= 1) {
    if (colorColumns[x] >= minimumColor) {
      left = Math.min(middleLeft, x + iconPadding);
      break;
    }
  }
  for (let x = middleRight; x <= right; x += 1) {
    if (colorColumns[x] >= minimumColor) {
      right = Math.max(middleRight - 1, x - iconPadding);
      break;
    }
  }

  // Turn light and muted lettering into dark ink while dropping saturated UI icons.
  const ink = new Uint8Array(width * height);
  const rows: Array<{ top: number; lines: CardLine[] }> = [];
  for (let i = 0; i <= thinDividers.length; i += 1) {
    const top = i === 0 ? 0 : thinDividers[i - 1].end + 1;
    const bottom = i === thinDividers.length ? height : thinDividers[i].start;
    const lineRows: Span[] = [];
    const rowBounds: Array<{ left: number; right: number }> = [];
    for (let y = top; y < bottom; y += 1) {
      let pixels = 0;
      let first = right;
      let last = left;
      for (let x = left; x <= right; x += 1) {
        const index = y * width + x;
        const contrast = brightness[index] - background;
        if (contrast < 16) continue;
        if (isColorful(data, index * 4)) continue;
        ink[index] = Math.min(255, (contrast - 12) * 5);
        first = Math.min(first, x);
        last = x;
        pixels += 1;
      }

      if (pixels < 2) continue;
      rowBounds[y - top] = { left: first, right: last };
      addToSpans(lineRows, y, Math.max(2, Math.round(cardHeight * 0.045)));
    }

    const lines = lineRows.filter(({ start, end }) => end - start + 1 >= cardHeight * 0.075)
      .map(({ start, end }) => {
        const bounds = rowBounds.slice(start - top, end - top + 1).filter(Boolean);
        return {
          top: start,
          bottom: end + 1,
          left: Math.min(...bounds.map((row) => row.left)),
          right: Math.max(...bounds.map((row) => row.right)) + 1
        };
      });
    rows.push({ top, lines });
  }

  // Require repeated, aligned text pairs before using the card layout for OCR.
  const isPair = ({ lines }: { lines: CardLine[] }) => lines.length === 2 &&
    Math.abs(lines[0].left - lines[1].left) <= cardHeight * 0.12 &&
    lines[1].top - lines[0].top < cardHeight / 2;
  const interior = rows.slice(1, -1);
  if (!interior.every(isPair)) return;

  const firstLineOffset = interior.reduce((sum, row) => sum + row.lines[0].top - row.top, 0) / interior.length;
  const isTitleAtEnd = ({ top, lines }: typeof rows[number]) => lines.length === 1 &&
    Math.abs(lines[0].top - top - firstLineOffset) < cardHeight * 0.1;
  const cards = rows.filter((row, i) => isPair(row) || (i === rows.length - 1 && isTitleAtEnd(row)))
    .map(({ lines }) => lines);
  return { cards, ink, cardHeight };
}

function isColorful(data: Uint8ClampedArray, offset: number) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const low = Math.min(r, g, b);
  return Math.max(r, g, b) - low > Math.max(34, low * 0.55);
}

function addToSpans(spans: Span[], position: number, allowedGap: number) {
  const previous = spans[spans.length - 1];
  if (previous && position - previous.end <= allowedGap + 1) previous.end = position;
  else spans.push({ start: position, end: position });
}
