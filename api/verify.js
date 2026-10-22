const fs = require("fs");
const { IncomingForm } = require("formidable");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const soncap = require("../data/soncap-hsn.json");

// Map: first six digits -> full code as stored in our SONCAP list
const soncapBySix = new Map();
for (const item of soncap.codes) {
  const digits = String(item.hsn).replace(/\D/g, "");
  if (digits.length >= 6) {
    const six = digits.slice(0, 6);
    if (!soncapBySix.has(six)) soncapBySix.set(six, String(item.hsn));
  }
}

// Pull likely HSN codes out of the PDF text
function extractRawCodes(text) {
  const found = [];

  // 1) Codes written right after a label such as "HS CODE", "HSN", "Tariff code"
  const labelled = /\b(?:H\.?S\.?N?\.?\s*(?:CODE|NO\.?|NUMBER)?|TARIFF\s*CODE)\s*[:#.\-]?\s*(\d{4}(?:[.\- ]?\d{2}){1,3})/gi;
  let m;
  while ((m = labelled.exec(text)) !== null) found.push(m[1].trim());

  // 2) Codes written in the usual dotted style, e.g. 8537.20.90
  const dotted = /\b\d{4}\.\d{2}(?:\.\d{2,4})?\b/g;
  while ((m = dotted.exec(text)) !== null) found.push(m[0]);

  // 3) Last resort: plain 8 or 10 digit numbers
  if (found.length === 0) {
    const plain = /\b(?:\d{10}|\d{8})\b/g;
    while ((m = plain.exec(text)) !== null) found.push(m[0]);
  }

  return found;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST to upload a PFI." });
  }

  try {
    const form = new IncomingForm({ maxFileSize: 4 * 1024 * 1024 });
    const [, files] = await form.parse(req);
    const file = files.pfi && files.pfi[0];
    if (!file) {
      return res.status(400).json({ error: "No file received. Upload the PFI as a PDF." });
    }

    const buffer = fs.readFileSync(file.filepath);

    let text = "";
    try {
      text = (await pdfParse(buffer)).text || "";
    } catch (e) {
      return res.status(422).json({
        error: "This PDF could not be opened. Ask the supplier to send it again."
      });
    }

    // Scanned or image-only PDFs have almost no text
    if (text.replace(/\s/g, "").length < 30) {
      return res.status(422).json({
        error: "This PDF can’t be read automatically. Ask the supplier to send a text-based PDF or a clearer copy."
      });
    }

    const seen = new Set();
    const codes = [];
    for (const raw of extractRawCodes(text)) {
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 6 || seen.has(digits)) continue;
      seen.add(digits);
      const six = digits.slice(0, 6);
      const matched = soncapBySix.get(six) || null;
      codes.push({
        raw,
        normalized: six,
        status: matched ? "match" : "review",
        matched
      });
    }

    return res.status(200).json({
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
