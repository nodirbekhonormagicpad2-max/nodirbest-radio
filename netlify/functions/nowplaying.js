// Netlify serverless function: best-effort Volnorez metadata discovery + iTunes artwork lookup.
const STATION='https://volnorez.com/nodirbest';
const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
async function lookup(artist,song){
 const query=encodeURIComponent(`${artist} ${song}`);
 try{const r=await fetch(`https://itunes.apple.com/search?term=${query}&entity=song&limit=12`,{signal:AbortSignal.timeout(7000)});if(!r.ok)return null;const j=await r.json();const norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');const a=norm(artist),t=norm(song);const result=(j.results||[]).find(x=>{let xa=norm(x.artistName),xt=norm(x.trackName);return (xa.includes(a)||a.includes(xa))&&(xt.includes(t)||t.includes(xt))});if(!result?.artworkUrl100)return null;return {image:result.artworkUrl100.replace(/100x100bb|100x100/g,'1200x1200bb'),imageType:'album'};}catch{return null}
}
function extract(html){
 // Only accept track text that looks like visible current-track metadata.
 const cleaned=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ');
 const matches=[...cleaned.matchAll(/(?:♫|♪|🎵|Сейчас играет|В эфире|Now playing)\s*[:：]?\s*([\p{L}\p{N} .,'’()&!]+?)\s+[-–—]\s+([\p{L}\p{N} .,'’()&!]+?)(?=\s{2,}|\s*(?:Listening|Слушателей|Коммент|Share|В эфире)|$)/giu)];
 for(const m of matches){const artist=m[1].trim(),song=m[2].trim();if(artist.length>1&&artist.length<100&&song.length>1&&song.length<130)return {artist,song}}
 return null;
}
exports.handler=async event=>{
 const p=event.queryStringParameters||{};if(p.artist&&p.song){const found=await lookup(p.artist.slice(0,120),p.song.slice(0,120));return {statusCode:200,headers,body:JSON.stringify({artist:p.artist,song:p.song,...found,diagnostic:found?'Artwork found':'No matching album art'})}}
 try{const r=await fetch(STATION,{headers:{'user-agent':'Mozilla/5.0 (compatible; NodirBestRadio/1.0)'},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error(`Volnorez returned HTTP ${r.status}`);const html=await r.text();const meta=extract(html);if(!meta)return {statusCode:200,headers,body:JSON.stringify({artist:null,song:null,diagnostic:'Volnorez page did not expose current song in server-readable HTML. A verified metadata endpoint is required.'})};const art=await lookup(meta.artist,meta.song);return {statusCode:200,headers,body:JSON.stringify({...meta,...art,diagnostic:art?'Metadata and artwork found':'Metadata found; matching artwork unavailable'})};}catch(e){return {statusCode:200,headers,body:JSON.stringify({artist:null,song:null,diagnostic:'Volnorez metadata fetch failed: '+e.message})}}
};
