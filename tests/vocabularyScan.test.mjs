import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null, hmr: false }
});
after(() => vite.close());

const { alignColumns, findColumns, findVocabularyPage } = await vite.ssrLoadModule("/src/lib/vocabularyColumns.ts");
const { parseScannedVocabulary } = await vite.ssrLoadModule("/src/lib/vocabularyScan.ts");
const { findDuplicateVocabularyRows, scanEntryContent, vocabularyIdentitiesMatch, vocabularyIdentity } = await vite.ssrLoadModule("/src/lib/vocabulary.ts");
const { acceptedTranslationForms, evaluateAnswer } = await vite.ssrLoadModule("/src/lib/matching.ts");
const languages = { targetLanguage: "es", baseLanguage: "bg" };

function lines(words, positions, x = 20) {
  return words.map((text, index) => ({ text, x, y: positions[index] }));
}

function parsedPairs(pairs, translationFirst = false, layout = "columns") {
  return parseScannedVocabulary({ layout, pairs }, "paired", translationFirst, languages);
}

test("ignores facing-page ink at the frame edge when locating the two vocabulary columns", () => {
  const width = 600;
  const height = 300;
  const ink = new Uint8Array(width * height);
  for (let y = 20; y < 260; y += 28) {
    for (let row = y; row < y + 9; row += 1) {
      ink.fill(255, row * width + 40, row * width + 190);
      ink.fill(255, row * width + 290, row * width + 450);
    }
  }
  for (let y = 10; y < 34; y += 1) ink.fill(255, y * width + 562, (y + 1) * width);
  assert.deepEqual(findColumns(ink, width, height), [{ left: 29, right: 201 }, { left: 279, right: 461 }]);
});

test("recovers two columns above textured background and keeps a lower group of vocabulary", () => {
  const width = 600;
  const height = 800;
  const ink = new Uint8Array(width * height);
  function addVocabulary(top) {
    for (let y = top; y < top + 100; y += 22) {
      for (let row = y; row < y + 8; row += 1) {
        ink.fill(255, row * width + 40, row * width + 190);
        ink.fill(255, row * width + 290, row * width + 450);
      }
    }
  }
  addVocabulary(50);
  addVocabulary(400);
  addVocabulary(600);
  assert.equal(findVocabularyPage(ink, width, height).bottom, height);

  ink.fill(0, 600 * width);
  for (let y = 670; y < height; y += 1) {
    for (let x = (y * 13) % 31; x < width; x += 31) ink[y * width + x] = 255;
  }
  assert.deepEqual(findVocabularyPage(ink, width, height), {
    columns: [{ left: 29, right: 201 }, { left: 279, right: 461 }], bottom: 670
  });
});

test("skips an isolated chapter title and retains a numeric entry with a translation", () => {
  const left = lines(["1 Viaje al español", "difícil", "1 euro", "el arroz"], [20, 85, 116, 148]);
  const right = lines(["труден", "1 евро", "ориз"], [86, 117, 149]);
  assert.deepEqual(alignColumns(left, right, 200), [
    { first: "difícil", second: "труден" }, { first: "1 euro", second: "1 евро" }, { first: "el arroz", second: "ориз" }
  ]);
});

test("keeps separate vocabulary rows across a blank section break", () => {
  const first = ["el aceite", "el alcohol", "el arroz", "el chocolate", "el concierto", "el día"];
  const second = ["зехтин", "алкохол", "ориз", "шоколад", "концерт", "ден"];
  const positions = [20, 50, 80, 155, 185, 215];
  assert.deepEqual(alignColumns(lines(first, positions), lines(second, positions), 200),
    first.map((term, index) => ({ first: term, second: second[index] })));
});

test("keeps vocabulary rows separate across a section break that follows a question", () => {
  const first = ["el aceite", "el alcohol", "¿Qué tal?", "el chocolate", "el concierto", "el día"];
  const second = ["зехтин", "алкохол", "Как си?", "шоколад", "концерт", "ден"];
  const positions = [20, 50, 80, 155, 185, 215];
  assert.deepEqual(alignColumns(lines(first, positions), lines(second, positions), 200),
    first.map((term, index) => ({ first: term, second: second[index] })));
});

test("keeps all vocabulary rows across two section breaks that follow complete phrases", () => {
  const first = ["el aceite", "el alcohol", "¿Qué tal?", "el chocolate", "el concierto", "¡Hola!", "el día", "la tarde", "la noche"];
  const second = ["зехтин", "алкохол", "Как си?", "шоколад", "концерт", "Здравей!", "ден", "следобед", "нощ"];
  const positions = [20, 50, 80, 155, 185, 215, 290, 320, 350];
  assert.deepEqual(alignColumns(lines(first, positions), lines(second, positions), 200),
    first.map((term, index) => ({ first: term, second: second[index] })));
});

test("joins a sentence in a mixed scan while leaving the other blocks as separate entries", () => {
  const first = ["Viajamos juntos", "a una ciudad nueva", "durante las vacaciones.", "el chocolate", "el concierto", "¡Hola!", "el día", "la tarde", "la noche"];
  const second = ["Пътуваме заедно", "до един нов град", "през ваканцията.", "шоколад", "концерт", "Здравей!", "ден", "следобед", "нощ"];
  const positions = [20, 50, 80, 155, 185, 215, 290, 320, 350];
  assert.deepEqual(alignColumns(lines(first, positions), lines(second, positions), 200), [
    { first: first.slice(0, 3).join(" "), second: second.slice(0, 3).join(" ") },
    ...first.slice(3).map((term, index) => ({ first: term, second: second[index + 3] }))
  ]);
});

test("retains an unmatched numeric entry and skips a numbered heading between bilingual sections", () => {
  const left = lines(["10 euros", "caro", "barato", "2 Primeros contactos", "¡Qué rico!", "¿Cómo estás?"], [5, 65, 96, 170, 239, 270]);
  const right = lines(["скъп", "евтин", "Колко вкусно!", "Как си?"], [66, 97, 240, 271]);
  assert.deepEqual(alignColumns(left, right, 200), [
    { first: "10 euros", second: "" }, { first: "caro", second: "скъп" }, { first: "barato", second: "евтин" },
    { first: "¡Qué rico!", second: "Колко вкусно!" }, { first: "¿Cómo estás?", second: "Как си?" }
  ]);
});

test("keeps an indented entry separate after a completed row in both columns", () => {
  const positions = [20, 51, 82, 113, 144, 175];
  const names = ["Madrid.", "Barcelona", "Valencia", "Bilbao", "Sevilla", "Granada"];
  const translated = ["Мадрид.", "Барселона", "Валенсия", "Билбао", "Севиля", "Гранада"];
  const left = lines(names, positions);
  const right = lines(translated, positions);
  left[1].x = right[1].x = 34;
  assert.deepEqual(alignColumns(left, right, 200), names.map((first, index) => ({ first, second: translated[index] })));
});

test("recognizes a scan containing a single wrapped bilingual entry", () => {
  const left = lines(["Viajamos juntos", "durante las vacaciones."], [20, 50]);
  const right = lines(["Пътуваме заедно", "през ваканцията."], [21, 51]);
  left[1].x = right[1].x = 36;
  const expected = [{ first: "Viajamos juntos durante las vacaciones.", second: "Пътуваме заедно през ваканцията." }];
  assert.deepEqual(alignColumns(left, right, 200), expected);
  assert.deepEqual(alignColumns(left, lines([expected[0].second], [21]), 200), expected);
});

test("joins flush-left continuation lines in both columns for a short scan", () => {
  const left = ["Viajamos juntos", "a una ciudad nueva", "durante las vacaciones.", "Mañana voy a comprar", "un cuaderno nuevo", "en la librería."];
  const right = ["Пътуваме заедно", "до един нов град", "през ваканцията.", "Утре ще си купя", "нова тетрадка", "от книжарницата."];
  const positions = [20, 50, 80, 145, 175, 205];
  assert.deepEqual(alignColumns(lines(left, positions), lines(right, positions), 200), [
    { first: left.slice(0, 3).join(" "), second: right.slice(0, 3).join(" ") },
    { first: left.slice(3).join(" "), second: right.slice(3).join(" ") }
  ]);
});

test("joins equally spaced translation lines on either physical side of the photo", () => {
  const source = ["Frase corta.", "Otra frase.", "Última frase."];
  const translation = ["Това е част", "от един доста", "дълъг превод.", "Това е друг", "пример за", "дълъг превод.", "А това е", "последният", "дълъг превод."];
  const single = lines(source, [20, 110, 200]);
  const wrapped = lines(translation, [23, 53, 83, 113, 143, 173, 203, 233, 263]);
  const expected = source.map((targetText, index) => ({ targetText, translations: translation.slice(index * 3, index * 3 + 3).join(" ") }));
  assert.deepEqual(parsedPairs(alignColumns(single, wrapped, 200)), expected);
  assert.deepEqual(parsedPairs(alignColumns(wrapped, single, 200), true), expected);
});

test("joins a photographed note that continues below its translation", () => {
  const left = lines(["la Panamericana", "la Patagonia", "la pizarra"], [20, 144, 178]);
  const right = [
    { text: "Панамерикана", x: 20, y: 21 },
    ...lines(["(Панамериканската", "магистрала, най-дългият", "автомобилен път)"], [51, 82, 113], 36),
    ...lines(["Патагония", "дъска за писане"], [145, 179])
  ];
  assert.deepEqual(parsedPairs(alignColumns(left, right, 200))[0], {
    targetText: "la Panamericana", translations: "Панамерикана", notes: "Панамериканската магистрала, най-дългият автомобилен път"
  });
});

test("keeps the photo-edge warning on a joined translation and reverses it with the columns", () => {
  const left = lines(["la identidad de tus", "compañeros/-as", "la información", "la lección"], [20, 50, 83, 115]);
  left[1].x = 36;
  const right = lines(["идентичност на твоите.", "съученици, колеги", "информация", "урок"], [18, 48, 81, 113]);
  right[0].clipped = true;
  right[1].x = 36;
  const expected = ["compañeros", "compañeras"].map((word) => ({
    targetText: `la identidad de tus ${word}`,
    translations: "идентичност на твоите. съученици, колеги",
    translationClipped: true
  }));
  assert.deepEqual(parsedPairs(alignColumns(left, right, 200)).slice(0, 2), expected);
  assert.deepEqual(parsedPairs(alignColumns(right, left, 200), true).slice(0, 2), expected);
});

test("keeps notes with the corresponding slash variants", () => {
  assert.deepEqual(parsedPairs([{
    first: "él (masculino) / ella (femenino)", second: "той [мъжки род] / тя [женски род]"
  }]), [
    { targetText: "él", translations: "той", notes: "masculino; мъжки род" },
    { targetText: "ella", translations: "тя", notes: "femenino; женски род" }
  ]);
  assert.deepEqual(parsedPairs([{ first: "el / la amigo/-a", second: "приятел (близък човек)" }]), [
    { targetText: "el amigo", translations: "приятел", notes: "близък човек" },
    { targetText: "la amiga", translations: "приятел", notes: "близък човек" }
  ]);
});

test("imports homographs with different notes and still detects repeated entries on rescan", () => {
  const rows = parsedPairs([
    { first: "el banco (asiento)", second: "пейка" },
    { first: "el banco (dinero)", second: "банка" }
  ]);
  assert.deepEqual(rows.map(scanEntryContent), [
    { targetText: "el banco", translations: ["пейка"], notes: "asiento" },
    { targetText: "el banco", translations: ["банка"], notes: "dinero" }
  ]);
  assert.deepEqual(findDuplicateVocabularyRows(rows, []), new Set());
  const saved = rows.map(scanEntryContent).map(vocabularyIdentity);
  assert.deepEqual(findDuplicateVocabularyRows(rows, saved), new Set([0, 1]));
  const reformatted = { targetText: " El   BANCO ", notes: " ASIENTO " };
  assert.ok(vocabularyIdentitiesMatch(vocabularyIdentity(reformatted), saved[0]));
});

test("treats missing notes as a match without letting a skipped row hide a different sense", () => {
  const unannotated = vocabularyIdentity({ targetText: "la casa", notes: "" });
  const annotated = vocabularyIdentity({ targetText: "la casa", notes: "f" });
  assert.ok(vocabularyIdentitiesMatch(unannotated, annotated));
  assert.ok(vocabularyIdentitiesMatch(annotated, unannotated));
  assert.deepEqual(findDuplicateVocabularyRows([
    { targetText: "el banco", notes: "asiento" },
    { targetText: "el banco", notes: "" },
    { targetText: "el banco", notes: "dinero" }
  ], []), new Set([1]));
});

test("recognizes entries saved with inline notes before OCR moved them into Notes", () => {
  const saved = [
    { targetText: "el banco (asiento)", translations: ["пейка"], notes: "" },
    { targetText: "¿Cómo está usted? (estar)", translations: ["Как сте? (Вие, учтива форма)"], notes: "" }
  ].map(vocabularyIdentity);
  const rows = parsedPairs([
    { first: "el banco (asiento)", second: "пейка" },
    { first: "el banco (dinero)", second: "банка" },
    { first: "¿Cómo está usted? (estar)", second: "Как сте? (Вие, учтива форма)" }
  ]);
  assert.deepEqual(findDuplicateVocabularyRows(rows, saved), new Set([0, 2]));
  assert.ok(!vocabularyIdentitiesMatch(vocabularyIdentity({ targetText: "(sich) freuen" }), vocabularyIdentity({ targetText: "freuen" })));
});

test("keeps a leading bracket group with the term and extracts a trailing note", () => {
  const german = { targetLanguage: "de", baseLanguage: "bg" };
  const english = { targetLanguage: "en", baseLanguage: "bg" };
  assert.deepEqual(parseScannedVocabulary({ layout: "columns", pairs: [
    { first: "(sich) freuen", second: "радвам се" },
    { first: "(sich) beeilen (reflexiv)", second: "бързам" }
  ] }, "paired", false, german), [
    { targetText: "(sich) freuen", translations: "радвам се" },
    { targetText: "(sich) beeilen", translations: "бързам", notes: "reflexiv" }
  ]);
  assert.deepEqual(parseScannedVocabulary({ layout: "columns", pairs: [{ first: "(to) run", second: "тичам" }] }, "paired", false, english), [
    { targetText: "(to) run", translations: "тичам" }
  ]);
});

test("ignores fallback separators inside notes and leaves attached endings and broken brackets editable", () => {
  assert.deepEqual(parseScannedVocabulary("la palabra (usada   en el aula)   el libro", "targetOnly", false, languages), [
    { targetText: "la palabra", translations: "", notes: "usada   en el aula" },
    { targetText: "el libro", translations: "" }
  ]);
  assert.deepEqual(parseScannedVocabulary("la palabra (uso: formal) — дума [пример (рядко); книжовно]", "paired", false, languages), [
    { targetText: "la palabra", translations: "дума", notes: "uso: formal; пример (рядко); книжовно" }
  ]);
  assert.deepEqual(parsedPairs([{ first: "Schüler(in)", second: "ученик (незатворено" }]), [
    { targetText: "Schüler(in)", translations: "ученик (незатворено" }
  ]);
});

test("keeps a wrapped note out of the translation requests in words-only mode", () => {
  assert.deepEqual(parseScannedVocabulary("la Panamericana (carretera que recorre\r\n varios países de América)\r\nla paella", "targetOnly", false, languages), [
    { targetText: "la Panamericana", translations: "", notes: "carretera que recorre varios países de América" },
    { targetText: "la paella", translations: "" }
  ]);
});

test("a stray bracket cannot swallow several entries or cross a numbered line", () => {
  assert.deepEqual(parseScannedVocabulary("la mesa (f\nel libro\nla casa\n2) el perro", "targetOnly", false, languages), [
    { targetText: "la mesa (f", translations: "" }, { targetText: "el libro", translations: "" },
    { targetText: "la casa", translations: "" }, { targetText: "el perro", translations: "" }
  ]);
  assert.deepEqual(parseScannedVocabulary("la mesa (f\n2) el perro", "targetOnly", false, languages), [
    { targetText: "la mesa (f", translations: "" }, { targetText: "el perro", translations: "" }
  ]);
  assert.equal(parseScannedVocabulary("la mesa (f\nel libro\nla casa)\nel perro", "targetOnly", false, languages).length, 4);
});

test("keeps a slash within one question and splits complete alternative questions", () => {
  assert.deepEqual(parsedPairs([{ first: "¿Cuál es tu / su teléfono?", second: "Какъв ти / ви е телефонният номер?" }]), [
    { targetText: "¿Cuál es tu / su teléfono?", translations: "Какъв ти / ви е телефонният номер?" }
  ]);
  assert.deepEqual(parsedPairs([{ first: "¿Dónde vives? / ¿Dónde vive usted?", second: "Къде живееш? / Къде живеете?" }]), [
    { targetText: "¿Dónde vives?", translations: "Къде живееш?" },
    { targetText: "¿Dónde vive usted?", translations: "Къде живеете?" }
  ]);
});

test("keeps a translation list separate from an edited multi-line note on import", () => {
  assert.deepEqual(scanEntryContent({
    targetText: " la identidad de tus\n compañeros ", translations: "идентичност на твоите\nсъученици; колеги",
    notes: "  учебен пример\nот първи урок  ", translationClipped: true
  }), {
    targetText: "la identidad de tus compañeros", translations: ["идентичност на твоите съученици", "колеги"],
    notes: "учебен пример\nот първи урок"
  });
});

test("accepts a translation with or without a leading abbreviated label", () => {
  const rows = parsedPairs([{ first: "el tío", second: "(разг.) пич" }]);
  assert.equal(rows[0].translations, "(разг.) пич");
  const accepted = acceptedTranslationForms(rows[0].translations);
  assert.equal(evaluateAnswer("пич", accepted), "correct");
  assert.equal(evaluateAnswer("(разг.) пич", accepted), "correct");
  assert.deepEqual(acceptedTranslationForms("(sich) freuen"), ["(sich) freuen"]);
});
