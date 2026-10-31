// NodirBest Radio — AudD API Saver
// Netlify Function

const STREAM_URL =
  "https://stream.volnorez.com/live-app/927955?br=192";

const CHECK_INTERVAL = 60 * 1000; // 60 soniya
const SAMPLE_DURATION = 6000;     // 6 soniya
const MAX_AUDIO_BYTES = 500000;

let lastCheck = 0;
let lastSong = null;
let pendingRequest = null;

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function respond(data) {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(data)
  };
}

// iTunes orqali albom rasmini topish
async function findArtwork(artist, song) {
  try {
    const query = encodeURIComponent(
      `${artist} ${song}`
    );

    const response = await fetch(
      `https://itunes.apple.com/search?term=${query}&entity=song&limit=20`,
      {
        signal: AbortSignal.timeout(7000)
      }
    );

    if (!response.ok) return null;

    const data = await response.json();

    const normalize = (text) =>
      String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "");

    const targetArtist = normalize(artist);
    const targetSong = normalize(song);

    const match = (data.results || []).find(item => {
      const itemArtist = normalize(item.artistName);
      const itemSong = normalize(item.trackName);

      return (
        itemArtist === targetArtist &&
        itemSong === targetSong &&
        item.artworkUrl100
      );
    });

    if (!match) return null;

    return match.artworkUrl100.replace(
      /100x100bb|100x100/g,
      "1200x1200bb"
    );

  } catch {
    return null;
  }
}

// Radio oqimidan audio olish
async function captureAudio() {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    SAMPLE_DURATION + 5000
  );

  let reader;

  try {
    const response = await fetch(STREAM_URL, {
      signal: controller.signal,
      headers: {
        Accept: "audio/mpeg,*/*"
      }
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Stream error: ${response.status}`
      );
    }

    reader = response.body.getReader();

    const chunks = [];
    let total = 0;

    const endTime = Date.now() + SAMPLE_DURATION;

    while (
      Date.now() < endTime &&
      total < MAX_AUDIO_BYTES
    ) {
      const { value, done } = await reader.read();

      if (done) break;

      if (value?.length) {
        chunks.push(value);
        total += value.length;
      }
    }

    if (total < 20000) {
      throw new Error("Audio sample too short");
    }

    const audio = new Uint8Array(total);

    let offset = 0;

    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }

    return audio;

  } finally {
    clearTimeout(timeout);
    controller.abort();

    try {
      await reader?.cancel();
    } catch {}
  }
}

// AudD orqali qo‘shiqni aniqlash
async function recognizeSong() {
  const token = process.env.AUDD_API_TOKEN;

  if (!token) {
    return {
      artist: null,
      song: null,
      image: null,
      diagnostic: "AUDD_API_TOKEN missing"
    };
  }

  try {
    const audio = await captureAudio();

    const form = new FormData();

    form.append("api_token", token);
    form.append("return", "apple_music,spotify");

    form.append(
      "file",
      new Blob([audio], {
        type: "audio/mpeg"
      }),
      "radio.mp3"
    );

    const response = await fetch(
      "https://api.audd.io/",
      {
        method: "POST",
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

    if (data.status !== "success") {
      const errorMessage =
        data.error?.error_message ||
        data.error?.error_code ||
        "Recognition error";

      return {
        artist: null,
        song: null,
        image: null,
        diagnostic: `AudD error: ${errorMessage}`
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
        diagnostic: "Song not recognized"
      };
    }

    const artist = data.result.artist;
    const song = data.result.title;

    const appleArtwork =
      data.result.apple_music?.artwork?.url
        ?.replace("{w}", "1200")
        .replace("{h}", "1200");

    const image =
      appleArtwork ||
      await findArtwork(artist, song);

    return {
      artist,
      song,
      image: image || null,
      imageType: image ? "album" : null,
      diagnostic: "Song recognized by AudD"
    };

  } catch (error) {
    return {
      artist: null,
      song: null,
      image: null,
      diagnostic: `Recognition failed: ${error.message}`
    };
  }
}

// Asosiy Netlify Function
exports.handler = async () => {
  const now = Date.now();

  // 60 soniya ichida qayta AudD chaqirilmaydi
  if (
    lastCheck &&
    now - lastCheck < CHECK_INTERVAL
  ) {
    return respond(
      lastSong || {
        artist: null,
        song: null,
        image: null,
        diagnostic: "Waiting for next check"
      }
    );
  }

  // Bir vaqtda bir nechta so‘rovni oldini olish
  if (!pendingRequest) {
    lastCheck = now;

    pendingRequest = recognizeSong()
      .then(result => {
        // Oxirgi yaxshi natijani saqlash
        if (result.artist && result.song) {
          lastSong = result;
        }

        return lastSong || result;
      })
      .finally(() => {
        pendingRequest = null;
      });
  }

  return respond(await pendingRequest);
};
