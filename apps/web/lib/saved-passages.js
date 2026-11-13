/** One-line preview of a passage: whitespace collapsed, cut to `max` chars with an ellipsis. */
function passagePreview(text, max = 120) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

module.exports = { passagePreview };
