const fs = require("fs");
const { IncomingForm } = require("formidable");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const soncap = require("../data/soncap-hsn.json");

// ---------- SONCAP lists (one per company) ----------
// Map per company: first six digits -> full code as stored in our list
const listsByCompany = {};
for (const [company, info] of Object.entries(soncap.companies)) {
  const bySix = new Map();
  for (const code of info.codes || []) {
    const digits = String(code).replace(/\D/g, "");
    if (digits.length >= 6) {
      const six = digits.slice(0, 6);
      if (!bySix.has(six)) bySix.set(six, String(code));
    }
  }
  listsByCompany[company] = bySix;
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
      // plain text of the page (used to detect scanned PDFs and for the label fallback)
      return tc.items.map((it) => it.str).join(" ");
    });
  }
  return pdfParse(buffer, { pagerender }).then((r) => ({ pages, text: r.text || "" }));
}

const HEADER = /^(?:H\.?\s?S\.?\s?N?\.?\s*(?:CODE|NO\.?|NUMBER)|HSN|HS|TARIFF\s*(?:CODE|NO\.?)|COMMODITY\s*CODE|CUSTOMS\s*CODE)$/i;
// A cell that is only an HS code: 6 to 10 digits, with optional dots, dashes or spaces
const CODE_CELL = /^\d{4}[.\-\s]?\d{2}(?:[.\-\s]?\d{2}){0,2}$/;

function validChapter(digits) {
  const ch = Number(digits.slice(0, 2));
  return ch >= 1 && ch <= 97 && ch !== 77;
}

// Method 1: find the HS CODE column header, then read only the cells in that column
function readColumn(pages) {
  const found = [];
  let column = null; // { cx, half } remembered across pages (headers are often not repeated)
  for (const items of pages) {
    let headerY = null;
    for (const it of items) {
      const whole = HEADER.test(it.s) && /code|no|number|hsn/i.test(it.s);
      // header split into two pieces, e.g. "HS" and "CODE" side by side
      const split = /^H\.?S\.?N?$/i.test(it.s) &&
        items.some((o) => /^CODE$/i.test(o.s) && Math.abs(o.y - it.y) < 3 && o.x > it.x && o.x - (it.x + it.w) < 12);
      if (whole || split) {
        const w = split ? it.w + 4 + 28 : it.w;
        column = { cx: it.x + w / 2, half: Math.max(w / 2, 18) };
        headerY = it.y;
        break;
      }
    }
    if (!column) continue;
    for (const it of items) {
      if (headerY !== null && it.y >= headerY) continue; // above the header on that page
      const cx = it.x + it.w / 2;
      if (Math.abs(cx - column.cx) > column.half + it.w / 2 + 4) continue;
      if (!CODE_CELL.test(it.s)) continue;
      const digits = it.s.replace(/\D/g, "");
      if (digits.length >= 6 && validChapter(digits)) found.push(it.s);
    }
  }
  return found;
}

// Method 2 (only if there is no HS CODE column): codes written next to a label,
// for example "HS Code: 8537.10.90". Phone numbers, fax and bank numbers are never read.
function readLabelled(text) {
  const found = [];
  const re = /\b(?:H\.?S\.?N?\.?\s*(?:CODE|NO\.?|NUMBER)|HSN|TARIFF\s*(?:CODE|NO\.?))\s*[:#.\-]?\s*(\d{4}(?:[.\-\s]?\d{2}){1,3})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1].replace(/\D/g, "");
    if (digits.length >= 6 && validChapter(digits)) found.push(m[1].trim());
  }
  return found;
}

// ---------- The endpoint ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST to upload a PFI." });
  }

  try {
    const form = new IncomingForm({ maxFileSize: 4 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);
    const file = files.pfi && files.pfi[0];
    if (!file) {
      return res.status(400).json({ error: "No file received. Upload the PFI as a PDF." });
    }

    const company = String((fields.company && fields.company[0]) || "IEPL");
    const list = listsByCompany[company];
    if (!list || list.size === 0) {
      return res.status(400).json({ error: "The SONCAP list for " + company + " has not been added yet." });
    }

    let pdf;
    try {
      pdf = await readPdfItems(fs.readFileSync(file.filepath));
    } catch (e) {
      return res.status(422).json({ error: "This PDF could not be opened. Ask the supplier to send it again." });
    }

    // Scanned or image-only PDFs have almost no text
    if (pdf.text.replace(/\s/g, "").length < 30) {
      return res.status(422).json({
        error: "This PDF can’t be read automatically. Ask the supplier to send a text-based PDF or a clearer copy."
      });
    }

    let method = "column";
    let rawCodes = readColumn(pdf.pages);
    if (rawCodes.length === 0) {
      method = "label";
      rawCodes = readLabelled(pdf.text);
    }

    const seen = new Set();
    const codes = [];
    for (const raw of rawCodes) {
      const digits = raw.replace(/\D/g, "");
      if (seen.has(digits)) continue;
      seen.add(digits);
      const six = digits.slice(0, 6);
      const matched = list.get(six) || null;
      codes.push({ raw, normalized: six, status: matched ? "match" : "review", matched });
    }

    return res.status(200).json({
      company,
      method,
      warning: method === "label" && codes.length > 0
        ? "No HS CODE column was found in this PDF, so codes were read from labels. Please check the list against the PFI."
        : null,
      allMatched: codes.length > 0 && codes.every((c) => c.status === "match"),
      codes
    });
  } catch (err) {
    const tooBig = err && /maxFileSize|allowed file size/i.test(String(err.message));
    return res.status(tooBig ? 413 : 500).json({
      error: tooBig ? "The PDF is larger than 4 MB. Send a smaller file." : "Something went wrong while checking the PFI."
    });
  }
};
