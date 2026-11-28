import { useId } from "react";

import type { LanguageCode } from "../types";

const flagWidth = 62;
const baseStart = 100 - flagWidth;
type FlagSide = "target" | "base";

// Flag colors and vector artwork from https://github.com/hampusborgos/country-flags.
const verticalBands: Partial<Record<LanguageCode, { end: number; color: string }[]>> = {
  fr: [{ end: 1 / 3, color: "#051440" }, { end: 2 / 3, color: "#fff" }, { end: 1, color: "#ec1920" }],
  it: [{ end: 1 / 3, color: "#008c45" }, { end: 2 / 3, color: "#fff" }, { end: 1, color: "#cd212a" }],
  pt: [{ end: 0.4, color: "#060" }, { end: 1, color: "red" }]
};

function flagBand(side: FlagSide, start: number, end: number) {
  const topLeft = side === "target" ? 0 : flagWidth;
  const bottomLeft = side === "target" ? 0 : baseStart;
  const topWidth = side === "target" ? flagWidth : baseStart;
  const bottomWidth = 100 - topWidth;
  return `M${topLeft + topWidth * start} 0H${topLeft + topWidth * end}L${bottomLeft + bottomWidth * end} 100H${bottomLeft + bottomWidth * start}Z`;
}

function flagAsset(language: LanguageCode) {
  return `${import.meta.env.BASE_URL}flags/${language === "en" ? "gb" : language}.svg`;
}

function FlagColors({ language, side, clip }: { language: LanguageCode; side: FlagSide; clip: string }) {
  const bands = verticalBands[language];
  if (bands) {
    // Taper each stripe with the side so the diagonal preserves every color from top to bottom.
    return <g>{bands.map(({ color, end }, index) => (
      <path key={color} d={flagBand(side, index === 0 ? 0 : bands[index - 1].end, end)} fill={color} />
    ))}</g>;
  }

  return (
    <g clipPath={`url(#${clip})`}>
      {language === "es" ? (
        <>
          <rect width="100" height="100" fill="#c60b1e" />
          <rect y="25" width="100" height="50" fill="#ffc400" />
        </>
      ) : (
        <image href={flagAsset(language)} x={side === "target" ? 0 : baseStart} width={flagWidth} height="100" preserveAspectRatio="none" />
      )}
    </g>
  );
}

function FlagEmblem({ language, side }: { language: LanguageCode; side: FlagSide }) {
  if (language !== "es" && language !== "pt") return null;
  const center = language === "es" ? 1 / 3 : 0.4;
  return (
    <img
      className="app-language-emblem"
      src={`${import.meta.env.BASE_URL}flags/${language}-emblem.svg`}
      style={{ left: `${(side === "target" ? 0 : 50) + 50 * center}%` }}
      alt=""
    />
  );
}

export function LanguageBackdrop({ target, base }: { target: LanguageCode; base: LanguageCode }) {
  const id = useId();
  const targetClip = `${id}-target`;
  const baseClip = `${id}-base`;

  return (
    <div className="app-language-backdrop" aria-hidden="true">
      <svg className="app-language-bands" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        <defs>
          <clipPath id={targetClip}>
            <path d={flagBand("target", 0, 1)} />
          </clipPath>
          <clipPath id={baseClip}>
            <path d={flagBand("base", 0, 1)} />
          </clipPath>
        </defs>
        <FlagColors language={target} side="target" clip={targetClip} />
        <FlagColors language={base} side="base" clip={baseClip} />
        <path d={`M${flagWidth} 0L${baseStart} 100`} stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <FlagEmblem language={target} side="target" />
      <FlagEmblem language={base} side="base" />
    </div>
  );
}
