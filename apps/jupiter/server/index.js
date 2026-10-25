import { newId, nowIso } from '../../../shared/ids.js';
import { v, allowKeys } from '../../../shared/validate.js';
import { badRequest, notFound, forbidden } from '../../../shared/errors.js';
import { reply } from '../../../http/http.js';

const MAX_MEDIA = 95 * 1024 * 1024;
const AUDIO_TYPES = new Set(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav','audio/x-wav','audio/webm','audio/flac','audio/x-flac']);
const IMAGE_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif']);
const safe = (x) => String(x || '').replace(/[^a-zA-Z0-9._ -]/g, '').trim().replace(/\s+/g, '-').slice(0, 120) || 'file';

function cols(storage) {
  return { tracks: storage.collection('jupiter_tracks', { indexes:['userId','artistId','albumId','createdAt'] }), artists: storage.collection('jupiter_artists',{indexes:['userId','name']}), albums: storage.collection('jupiter_albums',{indexes:['userId','artistId','title']}), playlists: storage.collection('jupiter_playlists',{indexes:['userId','updatedAt']}), playlistTracks: storage.collection('jupiter_playlist_tracks',{indexes:['playlistId','trackId']}), likes: storage.collection('jupiter_likes',{indexes:['userId','trackId']}), plays: storage.collection('jupiter_plays',{indexes:['userId','trackId','playedAt']}), commands: storage.collection('jupiter_player_commands',{indexes:['userId','createdAt']}) };
}
function gh(s){ const g=s.config.storage.github; if(!g?.token || !g?.repo) throw new Error('GitHub media storage is not configured'); return g; }
async function github(g, method, path, body, headers={}){ const r=await fetch(`https://api.github.com${path}`,{method,headers:{Authorization:`Bearer ${g.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'jupiter-media',...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined}); return r; }
async function mediaBranch(g){
  const branch=process.env.JUPITER_MEDIA_BRANCH||'universe-media';
  let r=await github(g,'GET',`/repos/${g.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if(r.ok) return branch;
  const repo=await github(g,'GET',`/repos/${g.repo}`); if(!repo.ok) throw new Error('Could not inspect GitHub repository');
  const info=await repo.json(); const base=info.default_branch||g.branch||'universe-data';
  const baseRef=await github(g,'GET',`/repos/${g.repo}/git/ref/heads/${encodeURIComponent(base)}`); if(!baseRef.ok) throw new Error('Could not inspect GitHub base branch');
  const sha=(await baseRef.json()).object.sha;
  r=await github(g,'POST',`/repos/${g.repo}/git/refs`,{ref:`refs/heads/${branch}`,sha});
  if(!r.ok && r.status!==422) throw new Error('Could not create Jupiter media branch');
  return branch;
}
async function putMedia(s, file, kind, owner, nameHint){
  if(!file?.data?.length) throw badRequest('A file is required');
  if(file.data.length>MAX_MEDIA) throw badRequest('File is too large; keep music under 95 MiB');
  const allowed=kind==='audio'?AUDIO_TYPES:IMAGE_TYPES; if(!allowed.has(file.contentType)) throw badRequest(`Unsupported ${kind} type`);
  const g=gh(s), branch=await mediaBranch(g), ext=(file.filename.match(/\.[A-Za-z0-9]+$/)||[''])[0].toLowerCase()|| (kind==='audio'?'.bin':'.jpg');
  const path=`jupiter/${kind}/${owner}/${newId(kind)}-${safe(nameHint)}${ext}`;
  const r=await github(g,'PUT',`/repos/${g.repo}/contents/${path}`,{message:`Jupiter: add ${kind}`,branch,content:file.data.toString('base64')});
  if(!r.ok) throw new Error(`GitHub media upload failed (${r.status})`);
  return { path, branch, size:file.data.length, contentType:file.contentType, filename:file.filename };
}
async function streamMedia(s,res,path,branch){
  const g=gh(s); if(!/^jupiter\/(audio|image)\/[A-Za-z0-9_-]+\//.test(path)) throw notFound();
  const raw=await fetch(`https://raw.githubusercontent.com/${g.repo}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`,{headers:{Authorization:`Bearer ${g.token}`,'User-Agent':'jupiter-media'}});
  if(!raw.ok) throw notFound('Media not found');
  res.statusCode=200; res.setHeader('Content-Type',raw.headers.get('content-type')||'application/octet-stream'); res.setHeader('Cache-Control','private, max-age=3600');
  if(raw.headers.get('content-length')) res.setHeader('Content-Length',raw.headers.get('content-length'));
  const b=Buffer.from(await raw.arrayBuffer()); return reply(200,b,{'Content-Type':raw.headers.get('content-type')||'application/octet-stream','Cache-Control':'private, max-age=3600'});
}
function own(user,id){ if(id!==user.id) throw forbidden(); }
function trackView(t,liked=false){ return {...t,liked}; }

export function register({router,services:s}){
  const C=cols(s.storage); const can=(u,p)=>s.permissions.assert(u,`jupiter.${p}`);
  const mediaBranchName=()=>process.env.JUPITER_MEDIA_BRANCH||'universe-media';
  router.add('GET','/api/apps/jupiter/meta',async({user})=>{await can(user,'library.read'); return {mediaBranch:mediaBranchName()};});
  router.add('GET','/api/apps/jupiter/library',async({user,query})=>{
    await can(user,'library.read'); const q=(query.get('q')||'').trim().toLowerCase(), sort=query.get('sort')||'createdAt';
    const [tracks,artists,albums]=await Promise.all([C.tracks.find({where:{userId:user.id},orderBy:{field:sort==='title'?'title':'createdAt',dir:sort==='title'?'asc':'desc'},limit:1000}),C.artists.find({where:{userId:user.id},limit:500}),C.albums.find({where:{userId:user.id},limit:500})]);
    const as=new Map(artists.map(x=>[x.id,x])), als=new Map(albums.map(x=>[x.id,x])); const likes=await C.likes.find({where:{userId:user.id},limit:10000}); const ls=new Set(likes.map(x=>x.trackId));
    const out=tracks.filter(t=>!q||[t.title,as.get(t.artistId)?.name,als.get(t.albumId)?.title,...(t.tags||[])].join(' ').toLowerCase().includes(q)).map(t=>({...trackView(t,ls.has(t.id)),artist:as.get(t.artistId)||null,album:als.get(t.albumId)||null}));
    return {tracks:out,artists,albums};
  });
  router.add('POST','/api/apps/jupiter/upload',async({user,body})=>{await can(user,'library.write'); const f=body?.files||{}; const title=String(body?.fields?.title||f.audio?.filename?.replace(/\.[^.]+$/,'')||'Untitled').trim().slice(0,160); const artistName=String(body?.fields?.artist||'Unknown Artist').trim().slice(0,120); const albumTitle=String(body?.fields?.album||'Singles').trim().slice(0,160); if(!f.audio) throw badRequest('Audio file is required');
    let artist=(await C.artists.find({where:{userId:user.id,name:artistName},limit:1}))[0]; if(!artist){artist=await C.artists.insert({id:newId('artist'),userId:user.id,name:artistName,imagePath:null});}
    let album=(await C.albums.find({where:{userId:user.id,artistId:artist.id,title:albumTitle},limit:1}))[0]; if(!album){album=await C.albums.insert({id:newId('album'),userId:user.id,artistId:artist.id,title:albumTitle,coverPath:null,year:body.fields?.year||null});}
    const audio=await putMedia(s,f.audio,'audio',user.id,title); let cover=null; if(f.cover) cover=await putMedia(s,f.cover,'image',user.id,`${artistName}-${albumTitle}`);
    if(cover) { await C.albums.update(album.id,{coverPath:cover.path}); album={...album,coverPath:cover.path}; }
    const t=await C.tracks.insert({id:newId('track'),userId:user.id,title,artistId:artist.id,albumId:album.id,duration:Number(body.fields?.duration||0)||0,trackNumber:Number(body.fields?.trackNumber||0)||0,tags:String(body.fields?.tags||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,20),audioPath:audio.path,audioBranch:audio.branch,coverPath:cover?.path||album.coverPath||null,createdAt:nowIso(),updatedAt:nowIso()});
    return reply(201,{track:trackView(t,false),artist,album});
  },{bodyLimit:100*1024*1024});
  router.add('POST','/api/apps/jupiter/artists/:id/cover',async({user,params,body})=>{await can(user,'library.write'); const a=await C.artists.get(params.id); if(!a||a.userId!==user.id) throw notFound(); const f=body?.files?.cover; const media=await putMedia(s,f,'image',user.id,a.name); return {artist:await C.artists.update(a.id,{imagePath:media.path})};},{bodyLimit:10*1024*1024});
  router.add('GET','/api/apps/jupiter/art/:id',async({user,params})=>{await can(user,'library.read'); const t=await C.tracks.get(params.id); if(!t||t.userId!==user.id||!t.coverPath) throw notFound(); const g=gh(s), raw=await fetch(`https://raw.githubusercontent.com/${g.repo}/${(t.audioBranch||mediaBranchName())}/${t.coverPath}`,{headers:{Authorization:`Bearer ${g.token}`,'User-Agent':'jupiter-media'}}); if(!raw.ok) throw notFound(); return reply(200,Buffer.from(await raw.arrayBuffer()),{'Content-Type':raw.headers.get('content-type')||'image/jpeg','Cache-Control':'private, max-age=3600'}); });
  router.add('GET','/api/apps/jupiter/media/:kind/:owner/:file',async({user,params,res})=>{await can(user,'library.read'); const tracks=await C.tracks.find({where:{userId:user.id},limit:10000}); let path=tracks.flatMap(t=>[t.audioPath,t.coverPath]).find(p=>p&&p.endsWith(`${params.owner}/${params.file}`)); if(!path) { const [a,al]=await Promise.all([C.artists.find({where:{userId:user.id},limit:10000}),C.albums.find({where:{userId:user.id},limit:10000})]); const paths=[...a.map(x=>x.imagePath),...al.map(x=>x.coverPath)].filter(Boolean); path=paths.find(p=>p.endsWith(`${params.owner}/${params.file}`)); } if(!path) throw notFound(); return streamMedia(s,res,path,mediaBranchName()); });
  router.add('GET','/api/apps/jupiter/stream/:id',async({user,params,res})=>{await can(user,'playback.read'); const t=await C.tracks.get(params.id); if(!t||t.userId!==user.id) throw notFound(); return streamMedia(s,res,t.audioPath,t.audioBranch||mediaBranchName()); });
  router.add('POST','/api/apps/jupiter/play',async({user,body})=>{await can(user,'playback.write'); const b=allowKeys(v.object(body),['trackIds','index','reason']); const ids=v.stringArray(b.trackIds,'trackIds',{max:500}); const tracks=await Promise.all(ids.map(id=>C.tracks.get(id))); const valid=tracks.filter(t=>t?.userId===user.id).map(t=>t.id); const cmd=await C.commands.insert({id:newId('cmd'),userId:user.id,action:'play',trackIds:valid,index:Number.isInteger(b.index)?b.index:0,reason:String(b.reason||'').slice(0,120),createdAt:nowIso()}); return {command:cmd}; });
  router.add('GET','/api/apps/jupiter/commands',async({user})=>{await can(user,'playback.read'); const xs=await C.commands.find({where:{userId:user.id},orderBy:{field:'createdAt',dir:'desc'},limit:10}); return {commands:xs};});
  router.add('POST','/api/apps/jupiter/plays',async({user,body})=>{await can(user,'playback.write'); const b=allowKeys(v.object(body),['trackId','seconds','completed']); const t=await C.tracks.get(v.anyId(b.trackId,'trackId')); if(!t||t.userId!==user.id) throw notFound(); const seconds=Math.max(0,Math.min(86400,Number(b.seconds)||0)); if(seconds<5&&!b.completed) return {ok:true,ignored:true}; const p=await C.plays.insert({id:newId('play'),userId:user.id,trackId:t.id,seconds,completed:!!b.completed,playedAt:nowIso()}); return {play:p}; });
  router.add('POST','/api/apps/jupiter/likes/:id',async({user,params})=>{await can(user,'playback.write'); const t=await C.tracks.get(params.id); if(!t||t.userId!==user.id) throw notFound(); const id=`${user.id}_${t.id}`; const old=await C.likes.get(id); if(old){await C.likes.delete(id);return {liked:false};} await C.likes.insert({id,userId:user.id,trackId:t.id,createdAt:nowIso()}); return {liked:true};});
  router.add('GET','/api/apps/jupiter/stats',async({user})=>{await can(user,'stats.read'); const plays=await C.plays.find({where:{userId:user.id},limit:10000}); const tracks=await C.tracks.find({where:{userId:user.id},limit:10000}); const artists=await C.artists.find({where:{userId:user.id},limit:1000}); const am=new Map(artists.map(a=>[a.id,a.name])), tm=new Map(tracks.map(t=>[t.id,t])); const song=new Map(), artist=new Map(); let seconds=0; for(const p of plays){seconds+=p.seconds||0;song.set(p.trackId,(song.get(p.trackId)||0)+1);const n=am.get(tm.get(p.trackId)?.artistId)||'Unknown';artist.set(n,(artist.get(n)||0)+1);} const top=(m,mapper)=>[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([id,count])=>mapper(id,count)); return {summary:{plays:plays.length,seconds,minutes:Math.round(seconds/60),tracks:tracks.length},topSongs:top(song,(id,count)=>({track:tm.get(id),count})),topArtists:top(artist,(name,count)=>({name,count}))};});
  router.add('GET','/api/apps/jupiter/widget/summary',async({user})=>{const st=await stats(C,user);return {stats:[{label:'Songs',value:st.summary.tracks},{label:'Plays',value:st.summary.plays},{label:'Minutes',value:st.summary.minutes}]};});
  router.add('GET','/api/apps/jupiter/widget/top',async({user})=>{const st=await stats(C,user);return {items:st.topSongs.slice(0,6).map(x=>({title:x.track?.title||'Unknown',subtitle:`${x.count} play${x.count===1?'':'s'}`}))};});
  async function stats(C,user){const plays=await C.plays.find({where:{userId:user.id},limit:10000}),tracks=await C.tracks.find({where:{userId:user.id},limit:10000});const tm=new Map(tracks.map(t=>[t.id,t]));const song=new Map();let seconds=0;for(const p of plays){seconds+=p.seconds||0;song.set(p.trackId,(song.get(p.trackId)||0)+1)}return {summary:{plays:plays.length,seconds,minutes:Math.round(seconds/60),tracks:tracks.length},topSongs:[...song.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([id,count])=>({track:tm.get(id),count}))}};
  const tools=s.aiTools; tools?.registerApp('jupiter','jupiter.search',{parameters:{properties:{query:{type:'string',maxLength:100}},required:['query']},handler:async({query},{user})=>{const ts=await C.tracks.find({where:{userId:user.id},limit:1000}),as=await C.artists.find({where:{userId:user.id},limit:500}),als=await C.albums.find({where:{userId:user.id},limit:500});const am=new Map(as.map(a=>[a.id,a.name])),alm=new Map(als.map(a=>[a.id,a.title]));const q=query.toLowerCase();return {tracks:ts.filter(t=>[t.title,am.get(t.artistId),alm.get(t.albumId),...(t.tags||[])].join(' ').toLowerCase().includes(q)).slice(0,20).map(t=>({id:t.id,title:t.title,artist:am.get(t.artistId),album:alm.get(t.albumId),tags:t.tags||[]}))}}});
  tools?.registerApp('jupiter','jupiter.play',{parameters:{properties:{trackIds:{type:'array',items:{type:'string'},maxItems:50},reason:{type:'string',maxLength:120}},required:['trackIds']},handler:async({trackIds,reason},{user})=>{const ids=String(trackIds).split(',').map(x=>x.trim()).filter(Boolean).slice(0,50);const valid=[];for(const id of ids){const t=await C.tracks.get(id);if(t?.userId===user.id)valid.push(id)}const cmd=await C.commands.insert({id:newId('cmd'),userId:user.id,action:'play',trackIds:valid,index:0,reason:reason||'Nebula request',createdAt:nowIso()});return {accepted:true,commandId:cmd.id,trackIds:valid}}});
  tools?.registerApp('jupiter','jupiter.stats',{parameters:{properties:{}},handler:async(_a,{user})=>stats(C,user)});
  tools?.registerApp('jupiter','jupiter.createPlaylist',{parameters:{properties:{name:{type:'string',maxLength:80},trackIds:{type:'array',items:{type:'string'},maxItems:200}},required:['name','trackIds']},handler:async({name,trackIds},{user})=>{const ids=String(trackIds).split(',').map(x=>x.trim()).filter(Boolean).slice(0,200);const p=await C.playlists.insert({id:newId('playlist'),userId:user.id,name,createdAt:nowIso(),updatedAt:nowIso()});let pos=0;for(const id of ids){const t=await C.tracks.get(id);if(t?.userId===user.id)await C.playlistTracks.insert({id:newId('pltrack'),playlistId:p.id,trackId:id,position:pos++})}return {playlist:p,added:pos}}});
}
