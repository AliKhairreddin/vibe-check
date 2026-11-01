// Project only original creative text. Never expose policies, notes, model
// metadata, or other offers from the saved learning evidence.
export function creativeText(value: unknown) {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const evidence = object(value);
  const audio = object(evidence.audio_transcript);
  const chunks = Array.isArray(audio.chunks) ? audio.chunks : [];
  const transcript = text(audio.text) || chunks.map(chunk => text(object(chunk).text)).filter(Boolean).join('\n\n');
  const rows = Array.isArray(evidence.onscreen_text_ocr) ? evidence.onscreen_text_ocr : [];
  const onscreen = [...new Set(rows.map(row => text(object(row).text)).filter(Boolean))].join('\n\n');
  const adCopy = text(object(evidence.submitted_ad_copy).text);
  return {
    transcript: transcript || null,
    onscreen_text: onscreen || null,
    ad_copy: adCopy || null,
    // Coverage concerns OCR, not the transcript. An empty text field is not
    // evidence that the creative contains no speech or on-screen text.
    onscreen_text_partial: object(evidence.ocr_coverage).status === 'partial',
  };
}
