// Abgesicherte Chat-Schnittstelle.
// Modell, System-Prompt und Limits sind fest auf dem Server eingestellt.
// Der Browser darf nur den Chatverlauf schicken, nichts anderes.
import { SYSTEM } from './_system.js';

const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 800;              // maximale Antwortlänge
const MAX_MESSAGES = 20;             // maximal so viele Nachrichten im Verlauf
const MAX_MESSAGE_CHARS = 2000;      // maximale Länge einer einzelnen Nachricht
const MAX_TOTAL_CHARS = 12000;       // maximale Länge des ganzen Verlaufs
const RATE_LIMIT = 15;               // Anfragen pro Besucher ...
const RATE_WINDOW_MS = 60 * 1000;    // ... pro Minute

// Erlaubte Websites. Weitere per Umgebungsvariable ALLOWED_ORIGINS (kommagetrennt) ergänzen.
const ALLOWED_ORIGINS = [
  'https://grischa-bot.vercel.app',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
];

// Einfaches Rate-Limit pro Server-Instanz. Bremst Missbrauch, ersetzt aber nicht das
// Ausgabenlimit in der Anthropic Console (das bleibt die harte Obergrenze).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_LIMIT;
}

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const msgs = input.slice(-MAX_MESSAGES)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({
    role: m.role,
    content: typeof (m && m.content) === 'string' ? m.content.slice(0, MAX_MESSAGE_CHARS) : '',
  })).filter(m => m.content.trim().length > 0);

  // Die API erwartet, dass der Verlauf mit einer Kundennachricht beginnt und endet.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;

  const total = msgs.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_TOTAL_CHARS) return null;
  return msgs;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  if (!allowed) return res.status(403).json({ error: 'Zugriff nicht erlaubt.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unbekannt';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warten Sie einen Moment.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Der Assistent ist momentan nicht verfügbar.' });
  }

  const messages = cleanMessages(req.body && req.body.messages);
  if (!messages) {
    return res.status(400).json({ error: 'Die Nachricht ist leer oder zu lang.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages }),
    });

    if (!response.ok) {
      console.error('Anthropic API Fehler', response.status);
      return res.status(502).json({ error: 'Der Assistent ist momentan nicht verfügbar.' });
    }

    const data = await response.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({ reply: reply || 'Bitte kontaktieren Sie uns direkt.' });
  } catch (err) {
    console.error('Chat-Fehler', err && err.message);
    return res.status(500).json({ error: 'Der Assistent ist momentan nicht verfügbar.' });
  }
}
