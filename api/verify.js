const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const soncap = require("../data/soncap-hsn.json");
const eucData = require("../data/euc-codes.json");

// ---------- EUC list (NSA End-User Certificate controlled items) ----------
// data/euc-codes.json shape: { source, retrieved, codes: [ { hsn, description, category, remarks }, ... ] }
// "listed"   = the code is on the EUC list (an EUC code of 8 or 9 digits counts when it is the start of the code).
// "possible" = same first six digits as an EUC item, but a different tariff line. Check it.
const eucBySix = new Map();
const eucCatalog = [];
for (const e of eucData.codes || []) {
  const digits = String(e.hsn || "").replace(/\D/g, "");
  if (digits.length < 6) continue;
  const rec = { code: digits, description: String(e.description || "").trim(), category: e.category || "", remarks: e.remarks || "" };
  eucCatalog.push(rec);
  const six = digits.slice(0, 6);
  if (!eucBySix.has(six)) eucBySix.set(six, []);
  eucBySix.get(six).push(rec);
}
eucCatalog.sort((a, b) => a.code.localeCompare(b.code));
const EUC_NOTE = "This is a screening check against the NSA EUC list. Confirm with the NSA EUC office whether an EUC is required for your actual product.";

function eucLookup(digits) {
  if (digits.length < 6) return null;
  const entries = eucBySix.get(digits.slice(0, 6));
  if (!entries) return null;
  const padded = digits.padEnd(10, "0").slice(0, 10);
  const exact = entries.filter((e) => padded.startsWith(e.code));
  const hits = exact.length ? exact : entries;
  const dedupe = (arr) => { const seen = new Set(); return arr.filter((e) => { const k = e.code + "|" + e.description; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const unique = dedupe(hits);
  return {
    level: exact.length ? "listed" : "possible",
    total: unique.length,
    others: exact.length ? dedupe(entries).length - unique.length : 0, // other EUC lines sharing the first six digits
    matches: unique.slice(0, 6).map((e) => ({ code: e.code, description: e.description, category: e.category, remarks: e.remarks }))
  };
}

// ---------- SONCAP lists (one per company) ----------
// data/soncap-hsn.json shape:
//   companies.<KEY> = { name, permits: [..], codes: [ { hsn, description }, ... ] }
// Per company we keep: first six digits -> every full code on our list with that prefix.
const listsByCompany = {};
const permitsByCompany = {};
const catalogByCompany = {}; // for the browse list in the page
const namesByCompany = {};
for (const [company, info] of Object.entries(soncap.companies)) {
  const bySix = new Map();
  for (const entry of info.codes || []) {
    // accept both { hsn, description } and plain strings
    const hsn = typeof entry === "string" ? entry : entry && entry.hsn;
    const description = entry && typeof entry === "object" ? String(entry.description || "").trim() : "";
    const digits = String(hsn || "").replace(/\D/g, "");
    if (digits.length < 6) continue;
    const full = digits.padEnd(10, "0").slice(0, 10);
    const six = full.slice(0, 6);
    if (!bySix.has(six)) bySix.set(six, []);
    bySix.get(six).push({ code: full, description });
  }
  listsByCompany[company] = bySix;
  catalogByCompany[company] = [...bySix.values()].flat().sort((a, b) => a.code.localeCompare(b.code)).map((e) => {
    const eu = eucLookup(e.code);
    return { hsn: e.code, description: e.description, euc: eu ? eu.level : null };
  });
  namesByCompany[company] = info.name || company;
  permitsByCompany[company] = info.permits || [];
}

// Safeguard 4: a list match only means "this code is on the company's SONCAP list".
// It is not proof that the product or the permit is compliant.
const MATCH_NOTE = "A match means the code is on the SONCAP list. It does not prove the product or permit is compliant.";

function lookup(list, digits) {
  const entries = list.get(digits.slice(0, 6));
  if (!entries) return null;
  const padded = digits.padEnd(10, "0").slice(0, 10);
  const exact = entries.find((e) => e.code === padded);
  const best = exact || entries[0];
  return { matched: best.code, description: best.description, exact: Boolean(exact) };
}

// ---------- Reading the PDF ----------
// We keep every piece of text together with its position on the page,
// so we can read the "HS CODE" column instead of guessing from raw numbers.
function readPdfItems(buffer) {
  const pages = [];
  function pagerender(pageData) {
    return pageData.getTextContent({ normalizeWhitespace: true }).then((tc) => {
      pages.push(
        tc.items
          .filter((it) => it.str && it.str.trim())
          .map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width }))
      );
      return tc.items.map((it) => it.str).join(" ");
    });
  }
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");
  return pdfParse(buffer, { pagerender }).then((r) => ({ pages, text: r.text || "" }));
}

// One-piece headings, e.g. "HS CODE", "HSN", "Custom Code"
const HEADER = /^(?:H\.?\s?S\.?\s?N?\.?\s*(?:CODE|NO\.?|NUMBER)|HSN|HTS\s*CODE|HS|TARIFF\s*(?:CODE|NO\.?)|COMMODITY\s*CODE|CUSTOMS?\s*(?:CODE|TARIFF))$/i;
// Two-piece headings, written side by side ("HS" "CODE") or on two lines ("Custom" above "Code")
const HEAD_FIRST = /^(?:H\.?S\.?N?|HTS|TARIFF|COMMODITY|CUSTOMS?|HARMONI[SZ]ED)$/i;
const HEAD_SECOND = /^(?:CODE|NO\.?|NUMBER)$/i;
function findTwoPieceHeader(it, items) {
  if (!HEAD_FIRST.test(it.s)) return null;
  for (const o of items) {
    if (o === it || !HEAD_SECOND.test(o.s)) continue;
    const sameLine = Math.abs(o.y - it.y) < 3 && o.x > it.x && o.x - (it.x + it.w) < 12;
    const below = o.y < it.y && it.y - o.y < 22 && Math.abs(o.x + o.w / 2 - (it.x + it.w / 2)) < 25;
    if (sameLine || below) {
      const left = Math.min(it.x, o.x);
      const right = Math.max(it.x + it.w, o.x + o.w);
      return { cx: (left + right) / 2, width: right - left, y: Math.max(it.y, o.y) };
    }
  }
  return null;
}
// A cell that is only an HS code: 6, 8 or 10 digits, with optional dots, dashes or spaces
const CODE_CELL = /^\d{4}[.\-\s]?\d{2}(?:[.\-\s]?\d{2}){0,2}$/;

function validChapter(digits) {
  const ch = Number(digits.slice(0, 2));
  return ch >= 1 && ch <= 97 && ch !== 77;
}

// ---------- Safeguard 3: known document identifiers ----------
// Values written next to these labels are never HS codes.
const ID_WORDS =
  "PFI|PROFORMA(?:\\s+INVOICE)?|INVOICE|QUOTATION|QUOTE|P\\.?O\\.?|PURCHASE\\s+ORDER|REF(?:ERENCE)?|" +
  "ACCOUNT|ACCT|ACC\\.?|A\\/C|IBAN|SWIFT|BIC|TIN|VAT|BANK|ROUTING|SORT\\s+CODE|ZIP|POST(?:AL)?\\s*CODE|REG(?:ISTRATION)?";
const PHONE_WORDS = "TEL(?:EPHONE)?|PHONE|MOBILE|CELL|FAX|WHATSAPP|CONTACT";
const SUFFIX = "\\s*(?:NO\\.?|NUMBER|NUM\\.?|#)?\\s*[:#.\\-]?\\s*";
// reference-style identifiers: one unbroken token that contains a digit
const ID_TOKEN = new RegExp("\\b(?:" + ID_WORDS + ")" + SUFFIX + "([A-Z0-9][A-Z0-9\\-\\/.]{4,})", "gi");
// phone/fax numbers may contain spaces, brackets and a leading +
const ID_PHONE = new RegExp("\\b(?:" + PHONE_WORDS + ")" + SUFFIX + "([+(]?\\d[\\d\\s().+\\-\\/]{4,})", "gi");

function extractIdentifiers(text) {
  const out = [];
  for (const re of [ID_TOKEN, ID_PHONE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const digits = m[1].replace(/\D/g, "");
      if (digits.length >= 6) out.push(digits);
    }
  }
  return out;
}

// "exact": the number is the identifier. "inside": the number sits inside a longer identifier.
function identifierHit(digits, ids) {
  if (ids.includes(digits)) return "exact";
  if (ids.some((id) => id.length > digits.length && id.includes(digits))) return "inside";
  return null;
}

// ---------- Safeguard 1: the HS CODE column ----------
function readColumn(pages) {
  const found = [];
  let headerSeen = false;
  let column = null; // { cx, half } remembered across pages (headers are often not repeated)
  for (const items of pages) {
    let headerY = null;
    for (const it of items) {
      const whole = HEADER.test(it.s) && /code|no|number|hsn/i.test(it.s);
      const two = whole ? null : findTwoPieceHeader(it, items);
      if (whole || two) {
        const cx = whole ? it.x + it.w / 2 : two.cx;
        const w = whole ? it.w : two.width;
        column = { cx, half: Math.max(w / 2, 18) };
        headerY = whole ? it.y : two.y;
        headerSeen = true;
        break;
      }
    }
    if (!column) continue;
    for (const it of items) {
      if (headerY !== null && it.y >= headerY) continue;
      const cx = it.x + it.w / 2;
      if (Math.abs(cx - column.cx) > column.half + it.w / 2 + 4) continue;
      if (!CODE_CELL.test(it.s)) continue;
      const digits = it.s.replace(/\D/g, "");
      if (digits.length < 6) continue;
      // Safeguard 5: a code-shaped cell in the HS column with an impossible chapter
      // is flagged for review instead of being dropped.
      found.push({
        raw: it.s,
        source: "column",
        issue: validChapter(digits) ? null : "Chapter " + digits.slice(0, 2) + " is not a valid HS chapter."
      });
    }
  }
  return { found, headerSeen };
}

// ---------- Safeguard 2: labelled codes (only when there is no HS CODE column) ----------
// A value is read only when it directly follows a label such as "HS Code", "HSN", "Tariff Code" or "HS -".
// Unlabelled numbers are never picked up.
function readLabelled(text) {
  const found = [];
  // Labels: "HS Code", "HS No", "HSN", "HTS", "Tariff Code", "Custom(s) Code", and "HS - 85043100" / "HS: 85043100"
  const re = /\b(?:H\.?S\.?N?\.?[\s\-]*(?:CODE|NO\.?|NUMBER)|HSN|HTS|TARIFF\s*(?:CODE|NO\.?)|CUSTOMS?\s*(?:CODE|TARIFF)|H\.?S\.?(?=\s*[:\-\u2013\u2014]))\s*[:#.\-\u2013\u2014]?\s*(\d[\d.\-\s]{2,18})/gi;
  const STRICT = /^\d{4}(?:[.\-\s]?\d{2}){1,3}(?!\d)/;
  let m;
  while ((m = re.exec(text)) !== null) {
    const loose = m[1].trim();
    const strict = STRICT.exec(loose);
    if (strict && validChapter(strict[0].replace(/\D/g, ""))) {
      found.push({ raw: strict[0].trim(), source: "label", issue: null });
    } else {
      // Safeguard 5: there is a label, but what follows is not a clean HS code
      found.push({ raw: loose, source: "label", issue: "The value after the label is not a complete, valid HS code. Check it on the PFI." });
    }
  }
  return found;
}

// ---------- Reading Excel / CSV ----------
function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return "";
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if ("result" in v) return cellText(v.result);
    if ("text" in v) return cellText(v.text);
    return "";
  }
  return String(v);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === "," || ch === ";" || ch === "\t") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}


// ---------- Reading .xlsx without any extra package ----------
// An .xlsx file is a zip of XML files. We open it with Node's built-in zlib, so nothing needs installing.
function xmlDecode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function xmlAttrs(tag) {
  const o = {};
  String(tag).replace(/([\w:.\-]+)\s*=\s*"([^"]*)"/g, (m, k, v) => { o[k] = xmlDecode(v); return m; });
  return o;
}
function openZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    files.set(buf.toString("utf8", p + 46, p + 46 + nlen), { flags, method, csize, lho });
    p += 46 + nlen + elen + clen;
  }
  return {
    has: (name) => files.has(name),
    read(name) {
      const f = files.get(name);
      if (!f) throw new Error("missing " + name);
      if (f.flags & 1) throw new Error("encrypted");
      const start = f.lho + 30 + buf.readUInt16LE(f.lho + 26) + buf.readUInt16LE(f.lho + 28);
      const data = buf.subarray(start, start + f.csize);
      if (f.method === 0) return data.toString("utf8");
      if (f.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 80 * 1024 * 1024 }).toString("utf8");
      throw new Error("unsupported zip method");
    }
  };
}
function colIndex(ref) {
  const m = /^([A-Z]+)/i.exec(ref || "");
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function textRuns(xml) {
  const cleaned = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "", m;
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  while ((m = re.exec(cleaned)) !== null) out += xmlDecode(m[1]);
  return out;
}
function readXlsx(buffer) {
  const zip = openZip(buffer);
  if (!zip.has("xl/workbook.xml")) throw new Error("not an xlsx workbook");
  const shared = [];
  if (zip.has("xl/sharedStrings.xml")) {
    const sx = zip.read("xl/sharedStrings.xml");
    const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    let m;
    while ((m = re.exec(sx)) !== null) shared.push(m[1] ? textRuns(m[1]) : "");
  }
  // sheet name -> file, in workbook order
  const rels = {};
  if (zip.has("xl/_rels/workbook.xml.rels")) {
    const rx = zip.read("xl/_rels/workbook.xml.rels");
    (rx.match(/<Relationship\b[^>]*>/g) || []).forEach((tag) => {
      const a = xmlAttrs(tag);
      if (a.Id && a.Target) rels[a.Id] = a.Target.startsWith("/") ? a.Target.slice(1) : "xl/" + a.Target.replace(/^\.\//, "");
    });
  }
  const wbx = zip.read("xl/workbook.xml");
  const sheetFiles = (wbx.match(/<sheet\b[^>]*>/g) || []).map((tag, i) => {
    const a = xmlAttrs(tag);
    return rels[a["r:id"]] || "xl/worksheets/sheet" + (i + 1) + ".xml";
  });
  const grids = [];
  for (const file of sheetFiles) {
    if (!zip.has(file)) continue;
    const sx = zip.read(file);
    const grid = [];
    const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm;
    while ((rm = rowRe.exec(sx)) !== null) {
      if (!rm[1]) continue;
      const cells = [];
      let any = false, next = 0, cm;
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const a = xmlAttrs(cm[1]);
        let idx = colIndex(a.r);
        if (idx < 0) idx = next;
        next = idx + 1;
        const inner = cm[2] || "";
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        let val;
        if (a.t === "inlineStr") val = textRuns(inner);
        else if (!vm) continue;
        else if (a.t === "s") val = shared[Number(vm[1])];
        else if (a.t === "str") val = xmlDecode(vm[1]);
        else if (a.t === "b") val = vm[1] === "1";
        else if (a.t === "e" || a.t === "d") val = "";
        else { const num = Number(vm[1]); val = Number.isFinite(num) ? num : xmlDecode(vm[1]); }
        if (val === undefined || val === "") continue;
        cells[idx] = val;
        any = true;
      }
      if (any) grid.push(cells);
    }
    grids.push(grid);
  }
  return grids;
}

async function readExcel(buffer, ext) {
  const sheets = [];
  if (ext === ".csv") {
    sheets.push(parseCsv(buffer.toString("utf8").replace(/^\uFEFF/, "")));
  } else {
    for (const grid of readXlsx(buffer)) sheets.push(grid);
  }
  // rows joined with " | " so digits from different rows never run together
  const text = sheets.map((g) => g.map((r) => r.map(cellText).join(" ")).join(" | ")).join(" | ");
  return { sheets, text };
}

// Safeguard 1 for spreadsheets: find the HS CODE heading, then read only that column below it.
function readSheets(sheets) {
  const found = [];
  let headerSeen = false;
  for (const grid of sheets) {
    let cols = [];
    for (const row of grid) {
      const heads = [];
      row.forEach((v, i) => {
        const t = cellText(v).replace(/\s+/g, " ").trim();
        if (t && HEADER.test(t)) heads.push(i);
      });
      if (heads.length) { cols = heads; headerSeen = true; continue; }
      for (const i of cols) {
        const v = row[i];
        const t = cellText(v).trim();
        if (!t) continue;
        const digits = t.replace(/\D/g, "");
        const isNum = typeof v === "number";
        if (isNum && !Number.isInteger(v)) {
          found.push({ raw: t, source: "column", issue: "Excel number format may have changed this code. Check it." });
        } else if (isNum && (digits.length === 7 || digits.length === 9)) {
          found.push({ raw: "0" + digits, source: "column", issue: "Excel may have dropped a leading zero. Check it." });
        } else if (CODE_CELL.test(t)) {
          found.push({ raw: t, source: "column", issue: validChapter(digits) ? null : "Chapter " + digits.slice(0, 2) + " is not a valid HS chapter." });
        } else if (/^[\d.\-\s]+$/.test(t) && digits.length >= 4) {
          found.push({ raw: t, source: "column", issue: "Not a complete HS code. Check it." });
        }
      }
    }
  }
  return { found, headerSeen };
}

// ---------- Typed codes ----------
function parseManual(input) {
  const out = [];
  for (const part of String(input).split(/[,;\n\r]+/)) {
    const p = part.trim();
    if (!p) continue;
    const tokens = CODE_CELL.test(p) ? [p] : p.split(/\s+/);
    for (const t of tokens) {
      const digits = t.replace(/\D/g, "");
      if (!digits) continue;
      if (CODE_CELL.test(t)) {
        out.push({ raw: t, source: "manual", issue: validChapter(digits) ? null : "Chapter " + digits.slice(0, 2) + " is not a valid HS chapter." });
      } else {
        out.push({ raw: t, source: "manual", issue: "Enter 6, 8 or 10 digits." });
      }
    }
  }
  return out.slice(0, 200);
}

// ---------- The checking logic (no file handling, so it can be tested on its own) ----------
function analyse(doc, company) {
  const list = listsByCompany[company];
  if (!list || list.size === 0) {
    return { status: 400, error: "The SONCAP list for " + company + " has not been added yet." };
  }

  let method = "column";
  let candidates, ids = [];
  const col = { found: [], headerSeen: false };
  if (doc.manual != null) {
    method = "manual";
    candidates = parseManual(doc.manual);
  } else {
    Object.assign(col, doc.sheets ? readSheets(doc.sheets) : readColumn(doc.pages));
    candidates = col.found;
    if (candidates.length === 0) {
      method = "label";
      candidates = readLabelled(doc.text);
    }
    ids = extractIdentifiers(doc.text);
  }
  const seen = new Set();
  const codes = [];
  const excluded = [];

  for (const c of candidates) {
    const digits = c.raw.replace(/\D/g, "");
    if (seen.has(digits)) continue;
    seen.add(digits);

    const hit = identifierHit(digits, ids);
    // Safeguard 3: a labelled value that is really a PFI/phone/fax/bank number is not an HS code
    if (c.source === "label" && hit) {
      excluded.push({ raw: c.raw, reason: "Sits next to a PFI, phone, fax or account label." });
      continue;
    }

    const base = { raw: c.raw, normalized: digits.slice(0, 6), source: c.source, matched: null, matchedDescription: "", exact: false, reason: null, euc: eucLookup(digits) };

    // Safeguard 5: ambiguous context goes to manual review
    if (c.issue) {
      codes.push({ ...base, status: "review", reason: c.issue });
      continue;
    }
    if (hit === "exact") {
      codes.push({ ...base, status: "review", reason: "Also sits next to a PFI, phone or account label. Confirm it is an HS code." });
      continue;
    }

    // Safeguard 4: compare with the company's master list
    const m = lookup(list, digits);
    if (m) {
      codes.push({ ...base, status: "match", matched: m.matched, matchedDescription: m.description, exact: m.exact });
    } else {
      codes.push({ ...base, status: "not_in_list", reason: "First six digits are not on the SONCAP list." });
    }
  }

  const warnings = [];
  if (method === "label" && codes.length > 0) {
    warnings.push("No HS CODE column found. Codes were read from labels such as “HS Code” or “HS -”. Please check them against the PFI.");
  }
  if (method === "label" && col.headerSeen && col.found.length === 0) {
    warnings.push("An HS CODE heading was found but no codes could be read under it.");
  }

  return {
    status: 200,
    body: {
      company,
      name: namesByCompany[company] || company,
      method,
      warning: warnings.length ? warnings.join(" ") : null,
      allMatched: codes.length > 0 && codes.every((c) => c.status === "match"),
      counts: {
        match: codes.filter((c) => c.status === "match").length,
        notInList: codes.filter((c) => c.status === "not_in_list").length,
        review: codes.filter((c) => c.status === "review").length
      },
      eucCounts: {
        listed: codes.filter((c) => c.euc && c.euc.level === "listed").length,
        possible: codes.filter((c) => c.euc && c.euc.level === "possible").length
      },
      eucNote: EUC_NOTE,
      eucSource: { url: eucData.source, retrieved: eucData.retrieved, count: eucCatalog.length },
      permits: permitsByCompany[company] || [],
      note: MATCH_NOTE,
      excluded,
      codes
    }
  };
}

// ---------- The endpoint ----------
async function handler(req, res) {
  // GET /api/verify?company=IEPL  ->  the full SONCAP list for the browse dropdown
  if (req.method === "GET") {
    const params = new URL(req.url, "http://localhost").searchParams;
    if (params.get("list") === "euc") {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).json({
        source: eucData.source,
        retrieved: eucData.retrieved,
        count: eucCatalog.length,
        categories: [...new Set(eucCatalog.map((e) => e.category))].sort(),
        note: EUC_NOTE,
        codes: eucCatalog.map((e) => ({ hsn: e.code, description: e.description, category: e.category, remarks: e.remarks }))
      });
    }
    const company = params.get("company") || "IEPL";
    if (!Object.prototype.hasOwnProperty.call(catalogByCompany, company)) {
      return res.status(400).json({ error: "Unknown company: " + company });
    }
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json({
      company,
      name: namesByCompany[company],
      permits: permitsByCompany[company] || [],
      count: catalogByCompany[company].length,
      codes: catalogByCompany[company]
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST to check a PFI or GET to list codes." });
  }

  try {
    const { IncomingForm } = require("formidable");
    const form = new IncomingForm({ maxFileSize: 4 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);
    const file = files.pfi && files.pfi[0];
    const manual = String((fields.manual && fields.manual[0]) || "").trim();

    const company = String((fields.company && fields.company[0]) || "IEPL");
    if (!Object.prototype.hasOwnProperty.call(listsByCompany, company)) {
      return res.status(400).json({ error: "Unknown company: " + company });
    }

    let doc;
    if (!file) {
      if (!manual) return res.status(400).json({ error: "Upload a PFI (PDF or Excel) or type an HS code." });
      doc = { manual };
    } else {
      const ext = path.extname(file.originalFilename || "").toLowerCase();
      const buf = fs.readFileSync(file.filepath);
      if (ext === ".xls") {
        return res.status(422).json({ error: "Old .xls files can’t be read. Save the file as .xlsx and upload it again." });
      }
      if (ext === ".xlsx" || ext === ".csv") {
        try {
          doc = await readExcel(buf, ext);
        } catch (e) {
          return res.status(422).json({ error: "This Excel file could not be opened. Save it as .xlsx and try again." });
        }
        if (doc.text.replace(/\s|\|/g, "").length < 5) {
          return res.status(422).json({ error: "This spreadsheet is empty." });
        }
      } else if (ext === ".pdf" || /pdf/i.test(file.mimetype || "")) {
        try {
          doc = await readPdfItems(buf);
        } catch (e) {
          return res.status(422).json({ error: "This PDF could not be opened. Ask the supplier to send it again, or upload an Excel copy." });
        }
        // Scanned or image-only PDFs have almost no text
        if (doc.text.replace(/\s/g, "").length < 30) {
          return res.status(422).json({ error: "This PDF can’t be read automatically. Upload an Excel copy, or type the HS codes." });
        }
      } else {
        return res.status(415).json({ error: "Upload a PDF, .xlsx or .csv file." });
      }
    }

    const result = analyse(doc, company);
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(200).json(result.body);
  } catch (err) {
    const tooBig = err && /maxFileSize|allowed file size/i.test(String(err.message));
    return res.status(tooBig ? 413 : 500).json({
      error: tooBig ? "The file is larger than 4 MB. Send a smaller file." : "Something went wrong while checking the PFI."
    });
  }
}

module.exports = handler;
module.exports.analyse = analyse; // exported for tests
