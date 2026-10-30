// NodirBest Radio — AudD + iTunes artwork
// AUDD_API_TOKEN Netlify Environment Variables ichida saqlanadi.

const STREAM = 'https://stream.volnorez.com/live-app/927955?br=192';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

const SAMPLE_MS = 11000;
const MAX_BYTES = 600000;
const CACHE_MS = 60000;

let cached = null;
let cachedAt = 0;
let inflight = null;

const reply = data => ({
  statusCode: 200,
  headers: HEADERS,
  body: JSON.stringify(data)
});

async function artwork(artist, song) {
  const norm = s =>
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');

  try {
    const query = encodeURIComponent(`${artist} ${song}`);

    const res = await fetch(
      `https://itunes.apple.com/search?term=${query}&entity=song&limit=15`,
      { signal: AbortSignal.timeout(6500) }
    );

    if (!res.ok) return {};

    const data = await res.json();

    const a = norm(artist);
    const t = norm(song);

    const match = (data.results || []).find(x => {
      const xa = norm(x.artistName);
      const xt = norm(x.trackName);

      return (
        xa &&
        xt &&
        (xa.includes(a) || a.includes(xa)) &&
        (xt.includes(t) || t.includes(xt))
      );
    });

    if (!match?.artworkUrl100) return {};

    return {
      image: match.artworkUrl100.replace(
        /100x100bb|100x100/g,
        '1200x1200bb'
      ),
      imageType: 'album'
    };

  } catch {
    return {};
  }
}

async function sampleStream() {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    SAMPLE_MS + 4000
  );

  let reader;

  try {
    const res = await fetch(STREAM, {
      signal: controller.signal,
      headers: {
        accept: 'audio/mpeg,*/*'
      }
    });

    if (!res.ok || !res.body) {
      throw new Error(`Radio stream HTTP ${res.status}`);
    }

    reader = res.body.getReader();

    const parts = [];
    let bytes = 0;

    const until = Date.now() + SAMPLE_MS;

    while (
      Date.now() < until &&
      bytes < MAX_BYTES
    ) {
      const { value, done } = await reader.read();

      if (done) break;

      if (value?.length) {
        parts.push(value);
        bytes += value.length;
      }
    }

    if (bytes < 24000) {
      throw new Error(
        `Audio sample too short (${bytes} bytes)`
      );
    }

    const buffer = new Uint8Array(bytes);

    let pos = 0;

    for (const part of parts) {
      buffer.set(part, pos);
      pos += part.length;
    }

    return buffer;

  } finally {
    clearTimeout(timeout);
    controller.abort();

    try {
      await reader?.cancel();
    } catch {}
  }
}

async function recognize() {
  const token = process.env.AUDD_API_TOKEN;

  if (!token) {
    return {
      artist: null,
      song: null,
      diagnostic:
        'AUDD_API_TOKEN is missing from Netlify environment variables.'
    };
  }

  try {
    const sample = await sampleStream();

    const form = new FormData();

    form.append('api_token', token);
    form.append('return', 'apple_music,spotify');

    form.append(
      'file',
      new Blob([sample], {
        type: 'audio/mpeg'
      }),
      'radio-sample.mp3'
    );

    const res = await fetch(
      'https://api.audd.io/',
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!res.ok) {
      throw new Error(`AudD HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.status !== 'success') {
      const msg =
        typeof data.error === 'object'
          ? (
              data.error?.error_message ||
              data.error?.error_code ||
              'unknown'
            )
          : (data.error || data.status);

      return {
        artist: null,
        song: null,
        diagnostic:
          `AudD error: ${String(msg).slice(0, 160)}`
      };
    }

    if (
      !data.result?.artist ||
      !data.result?.title
    ) {
      return {
        artist: null,
        song: null,
        diagnostic:
          'AudD could not recognize the current audio sample.'
      };
    }

    const artist = data.result.artist;
    const song = data.result.title;

    const imageFromAudD =
      data.result.apple_music?.artwork?.url
        ?.replace('{w}', '1200')
        ?.replace('{h}', '1200');

    const art = imageFromAudD
      ? {
          image: imageFromAudD,
          imageType: 'album'
        }
      : await artwork(artist, song);

    return {
      artist,
      song,
      ...art,
      diagnostic: 'Song recognized by AudD.'
    };

  } catch (err) {
    return {
      artist: null,
      song: null,
      diagnostic:
        `Recognition failed: ${err.message}`
    };
  }
}

exports.handler = async event => {
  const p = event.queryStringParameters || {};

  // Qo'lda rasm qidirish funksiyasi
  if (p.artist && p.song) {
    const artist = String(p.artist).slice(0, 120);
    const song = String(p.song).slice(0, 120);

    const art = await artwork(artist, song);

    return reply({
      artist,
      song,
      ...art,
      diagnostic: art.image
        ? 'Artwork found'
        : 'No matching album art'
    });
  }

  // AudD so'rovlarini vaqtincha keshlash
  if (
    cached &&
    Date.now() - cachedAt < CACHE_MS
  ) {
    return reply(cached);
  }

  if (!inflight) {
    inflight = recognize()
      .then(result => {
        cached = result;
        cachedAt = Date.now();
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }

  return reply(await inflight);
};
