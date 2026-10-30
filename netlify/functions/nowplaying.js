// NodirBest Radio — AudD + original album artwork

const STREAM =
  'https://stream.volnorez.com/live-app/927955?br=192';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

const SAMPLE_MS = 6000;
const MAX_BYTES = 500000;
const CACHE_MS = 5000;

let cached = null;
let cachedAt = 0;
let inflight = null;

function reply(data) {
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify(data)
  };
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Shubhali to'plam albomlarni filtrlash
function isCompilation(album) {
  return /(?:various artists|top hits|greatest hits|best of|pride hits|party hits|mega hits|summer hits|chart hits|hits 20\d\d|collection|compilation|karaoke|tribute)/i
    .test(album || '');
}

// iTunes'dan mos albom muqovasini topish
async function findArtwork(artist, song) {
  try {
    const query = encodeURIComponent(
      `${artist} ${song}`
    );

    const response = await fetch(
      `https://itunes.apple.com/search?term=${query}&entity=song&limit=50`,
      {
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!response.ok) return {};

    const data = await response.json();

    const wantedArtist = normalize(artist);
    const wantedSong = normalize(song);

    const matches = (data.results || []).filter(item => {
      const itemArtist = normalize(item.artistName);
      const itemSong = normalize(item.trackName);

      const sameArtist =
        itemArtist === wantedArtist;

      const sameSong =
        itemSong === wantedSong;

      const validAlbum =
        !isCompilation(item.collectionName);

      return (
        sameArtist &&
        sameSong &&
        validAlbum &&
        item.artworkUrl100
      );
    });

    if (!matches.length) return {};

    // To'plam bo'lmagan albomlarni afzal ko'rish
    matches.sort((a, b) => {
      const aScore =
        a.collectionName?.toLowerCase()
          .includes('single') ? 1 : 0;

      const bScore =
        b.collectionName?.toLowerCase()
          .includes('single') ? 1 : 0;

      return aScore - bScore;
    });

    const best = matches[0];

    return {
      image: best.artworkUrl100.replace(
        /100x100bb|100x100/g,
        '1200x1200bb'
      ),
      imageType: 'album'
    };

  } catch {
    return {};
  }
}

// Radio oqimidan audio namuna olish
async function sampleStream() {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    SAMPLE_MS + 5000
  );

  let reader;

  try {
    const response = await fetch(STREAM, {
      signal: controller.signal,
      headers: {
        accept: 'audio/mpeg,*/*'
      }
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Stream HTTP ${response.status}`
      );
    }

    reader = response.body.getReader();

    const chunks = [];
    let total = 0;

    const deadline = Date.now() + SAMPLE_MS;

    while (
      Date.now() < deadline &&
      total < MAX_BYTES
    ) {
      const { value, done } = await reader.read();

      if (done) break;

      if (value?.length) {
        chunks.push(value);
        total += value.length;
      }
    }

    if (total < 20000) {
      throw new Error('Audio sample too short');
    }

    const result = new Uint8Array(total);

    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;

  } finally {
    clearTimeout(timeout);
    controller.abort();

    try {
      await reader?.cancel();
    } catch {}
  }
}

// AudD orqali qo'shiqni aniqlash
async function recognize() {
  const token = process.env.AUDD_API_TOKEN;

  if (!token) {
    return {
      artist: null,
      song: null,
      image: null,
      diagnostic: 'AUDD_API_TOKEN missing'
    };
  }

  try {
    const audio = await sampleStream();

    const form = new FormData();

    form.append('api_token', token);

    form.append(
      'file',
      new Blob([audio], {
        type: 'audio/mpeg'
      }),
      'radio.mp3'
    );

    const response = await fetch(
      'https://api.audd.io/',
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      throw new Error(
        `AudD HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (data.status !== 'success') {
      return {
        artist: null,
        song: null,
        image: null,
        diagnostic: 'AudD recognition error'
      };
    }

    if (
      !data.result?.artist ||
      !data.result?.title
    ) {
      return {
        artist: null,
        song: null,
        image: null,
        diagnostic: 'Song not recognized'
      };
    }

    const artist = data.result.artist;
    const song = data.result.title;

    const artwork = await findArtwork(
      artist,
      song
    );

    return {
      artist,
      song,
      image: artwork.image || null,
      imageType: artwork.imageType || null,
      diagnostic: artwork.image
        ? 'Original album artwork found'
        : 'Song recognized; artwork unavailable'
    };

  } catch (error) {
    return {
      artist: null,
      song: null,
      image: null,
      diagnostic:
        `Recognition failed: ${error.message}`
    };
  }
}

exports.handler = async event => {
  const params = event.queryStringParameters || {};

  // Qo'lda qo'shiq rasmi qidirish
  if (params.artist && params.song) {
    const artist = String(params.artist)
      .slice(0, 120);

    const song = String(params.song)
      .slice(0, 120);

    const artwork = await findArtwork(
      artist,
      song
    );

    return reply({
      artist,
      song,
      image: artwork.image || null,
      imageType: artwork.imageType || null,
      diagnostic: artwork.image
        ? 'Artwork found'
        : 'Artwork unavailable'
    });
  }

  // Qisqa muddatli kesh
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
