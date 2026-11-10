
// NodirBest Radio — AzuraCast Now Playing
// Netlify Function
// AudD API kerak emas

const AZURACAST_URL = "https://a8.asurahosting.com";

// AzuraCast stansiya identifikatori
const STATION_ID = "nodirbest_radio";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*"
};

function respond(data, statusCode = 200) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(data)
  };
}

// iTunes orqali albom rasmini qidirish
async function findArtwork(artist, song) {
  try {
    const query = encodeURIComponent(`${artist} ${song}`);

    const response = await fetch(
      `https://itunes.apple.com/search?term=${query}&entity=song&limit=20`,
      { signal: AbortSignal.timeout(7000) }
    );

    if (!response.ok) return null;

    const data = await response.json();

    const normalize = text =>
      String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "");

    const targetArtist = normalize(artist);
    const targetSong = normalize(song);

    const match = (data.results || []).find(item =>
      normalize(item.artistName) === targetArtist &&
      normalize(item.trackName) === targetSong &&
      item.artworkUrl100
    );

    return match
      ? match.artworkUrl100.replace(
          /100x100bb|100x100/g,
          "1200x1200bb"
        )
      : null;
  } catch {
    return null;
  }
}

// AzuraCast API orqali hozirgi qo‘shiq
async function getNowPlaying() {
  const apiUrl =
    `${AZURACAST_URL}/api/nowplaying/` +
    encodeURIComponent(STATION_ID);

  const response = await fetch(apiUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`AzuraCast HTTP ${response.status}`);
  }

  const data = await response.json();
  const track = data.now_playing?.song;

  if (!track) {
    throw new Error("Now Playing data not found");
  }

  const artist = track.artist || "NodirBest Radio";
  const song = track.title || "Your music, your vibe";

  // Avval AzuraCast rasmini ishlatamiz
  let image = track.art || null;

  // AzuraCast rasmi bo‘lmasa, iTunes’dan qidiramiz
  if (!image && track.artist && track.title) {
    image = await findArtwork(track.artist, track.title);
  }

  return {
    artist,
    song,
    image,
    imageType: image ? "album" : null,
    diagnostic: "AzuraCast API",
    isOnline: data.is_online ?? null
  };
}

// Netlify Function
exports.handler = async () => {
  try {
    const result = await getNowPlaying();
    return respond(result);
  } catch (error) {
    console.error("Now Playing error:", error.message);

    return respond({
      artist: null,
      song: null,
      image: null,
      diagnostic: error.message
    });
  }
};
