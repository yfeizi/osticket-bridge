// English branch-name suggestions for subjects in other scripts.
//
// Order: 1) Chrome's on-device Translator / LanguageDetector (Chrome 138+;
// offline, nothing leaves the machine), 2) the online service chosen in
// Settings (MyMemory or a LibreTranslate instance) via the service worker,
// 3) nothing — the caller keeps "ticket-<number>" and the user types a name.

// Returns { text, engine } or null when the built-in API cannot do this pair.
async function translateBuiltin(text, source, onStatus) {
  if (typeof Translator === 'undefined') return null;

  let src = source;
  if ((!src || src === 'auto') && typeof LanguageDetector !== 'undefined') {
    try {
      const det = await LanguageDetector.create();
      const best = (await det.detect(text))[0];
      if (best && best.detectedLanguage && best.detectedLanguage !== 'und') src = best.detectedLanguage;
    } catch { /* fall through to the heuristic */ }
  }
  if (!src || src === 'auto') return null;
  if (src === 'en') return { text, engine: 'already English' };

  const opts = { sourceLanguage: src, targetLanguage: 'en' };
  const availability = await Translator.availability(opts).catch(() => 'unavailable');
  if (availability === 'unavailable') return null;
  if (availability !== 'available') onStatus('downloading Chrome translation model (one-time)…');
  const tr = await Translator.create(opts);
  return { text: await tr.translate(text), engine: 'Chrome built-in' };
}

// True when the built-in translator could run right now without a download
// (used to auto-suggest silently when the popup opens).
async function builtinReady(source) {
  if (typeof Translator === 'undefined' || !source || source === 'auto') return false;
  const a = await Translator.availability({ sourceLanguage: source, targetLanguage: 'en' }).catch(() => 'unavailable');
  return a === 'available';
}

async function suggestEnglish(text, settings, onStatus) {
  const source = settings.sourceLang && settings.sourceLang !== 'auto' ? settings.sourceLang : detectLang(text);

  const builtin = await translateBuiltin(text, source, onStatus).catch(() => null);
  if (builtin) return builtin;

  if (settings.translateService === 'off') {
    throw new Error('no offline translator in this browser — enable an online service in Settings');
  }
  onStatus(`asking ${settings.translateService === 'libre' ? 'LibreTranslate' : 'MyMemory'}…`);
  const r = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'TRANSLATE', settings, text, source }, resolve));
  if (!r || !r.ok) throw new Error(r ? r.error : 'no response');
  return r;
}
