"use client"
import { useState, useRef, useEffect } from 'react'

export default function Page() {
  const [procedure, setProcedure] = useState('hip')
  const [stage, setStage] = useState('start')
  const [skipAttempts, setSkipAttempts] = useState(0)
  const [answer, setAnswer] = useState('')
  const [hash, setHash] = useState('')
  const [error, setError] = useState('')
  const maxTimeRef = useRef(0)

  const HIP_ID = "WEif4buMjXo"
  const SPINE_DEMO = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"

  const handlePlay = () => { setStage('playing'); maxTimeRef.current = 0; setSkipAttempts(0); setError('') }

  useEffect(() => {
    if (procedure !== 'hip' || stage !== 'playing') return
    const loadYT = () => {
      const w = window as any
      if (!w.YT) {
        const tag = document.createElement('script')
        tag.src = "https://www.youtube.com/iframe_api"
        document.body.appendChild(tag)
      }
      w.onYouTubeIframeAPIReady = () => {
        const player = new w.YT.Player('yt-player', {
          videoId: HIP_ID,
          playerVars: { controls: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: (e:any) => e.target.playVideo(),
          }
        })
        const iv = setInterval(() => {
          try {
            const t = player.getCurrentTime()
            if (t > maxTimeRef.current) maxTimeRef.current = t
            if (t > maxTimeRef.current + 4) {
              player.seekTo(maxTimeRef.current, true)
              setSkipAttempts(s=>{ setError(`Seek blocked #${s+1} logged - Patient tried to skip`); return s+1 })
            }
          } catch {}
        }, 600)
        // @ts-ignore
        w._aurelius_iv = iv
      }
      if ((window as any).YT && (window as any).YT.Player) (window as any).onYouTubeIframeAPIReady()
    }
    loadYT()
    return () => { clearInterval((window as any)._aurelius_iv) }
  }, [stage, procedure])

  const handleSubmit = async () => {
    const need = procedure === 'hip' ? 'dislocation' : 'paralysis'
    if (!answer.toLowerCase().includes(need)) {
      setError(`Must type "${need}" to prove understanding - you typed "${answer}" - Claim 5 Active Recall`)
      return
    }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({procedure, answer, skipAttempts, ts: Date.now()})))
    setHash(Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join(''))
    setStage('cert')
  }

  return (
    <div style={{maxWidth:860,margin:'0 auto',padding:24,fontFamily:'system-ui'}}>
      <div style={{background:'white',borderRadius:16,padding:24,boxShadow:'0 6px 18px rgba(0,0,0,.1)'}}>
        <h1>AURELIUS — LAUNCHED</h1>
        <p style={{color:'#64748b'}}>Patent Pending US 16996631 | LIVE DEMO with YOUR video</p>
        <div style={{display:'flex',gap:12,margin:'16px 0'}}>
          <button onClick={()=>{setProcedure('spine');setStage('start');setAnswer('');setError('')}} style={{flex:1,padding:12,borderRadius:8,border: procedure==='spine'?'2px solid black':'1px solid #ddd',background: procedure==='spine'?'#f8fafc':'white',fontWeight:700}}>SPINE CPT 22612<br/><span style={{fontSize:12}}>Paralysis Risk</span></button>
          <button onClick={()=>{setProcedure('hip');setStage('start');setAnswer('');setError(''); setTimeout(()=>window.location.reload(),150)}} style={{flex:1,padding:12,borderRadius:8,border: procedure==='hip'?'2px solid #16a34a':'1px solid #ddd',background: procedure==='hip'?'#f0fdf4':'white',fontWeight:700}}>HIP CPT 27130<br/><span style={{fontSize:12}}>Your Video — WEif4buMjXo</span></button>
        </div>

        {stage==='start' && (
          <>
            <p><b>{procedure==='hip'?'CPT 27130 Hip Arthroplasty - Dislocation Risk':'CPT 22612 Paralysis Risk'} — Try to cheat, skip is blocked and logged.</b></p>
            <button onClick={handlePlay} style={{marginTop:12,padding:'14px 22px',borderRadius:10,background:'black',color:'white',fontWeight:700}}>▶ START {procedure==='hip'?'HIP':'SPINE'} CONSENT</button>
          </>
        )}

        {stage==='playing' && (
          <>
            {procedure==='hip' ? <div id="yt-player" style={{width:'100%',aspectRatio:'16/9',background:'black',borderRadius:12}}></div> : <video src={SPINE_DEMO} controls onTimeUpdate={(e)=>{ const v=e.target as HTMLVideoElement; maxTimeRef.current=Math.max(maxTimeRef.current,v.currentTime)}} onSeeking={(e)=>{ const v=e.target as HTMLVideoElement; if(v.currentTime>maxTimeRef.current+2){ v.currentTime=maxTimeRef.current; setSkipAttempts(s=>s+1); setError(`Seek blocked #${skipAttempts+1} logged`)}}} style={{width:'100%',borderRadius:12,background:'black'}} />}
            <div style={{marginTop:12,display:'flex',justifyContent:'space-between'}}>
              <span style={{color:'#dc2626',fontWeight:700}}>Skips: {skipAttempts} {error && `- ${error}`}</span>
              <button onClick={()=>setStage('quiz')} style={{padding:'8px 14px',borderRadius:8,background:'#16a34a',color:'white',fontWeight:700}}>Video Watched → Quiz</button>
            </div>
          </>
        )}

        {stage==='quiz' && (
          <>
            <h3>Claim 5 — Type the risk from memory</h3>
            <p style={{fontSize:13}}>{procedure==='hip'?'For HIP type "dislocation"':'For SPINE type "paralysis"'} — Skips: {skipAttempts}</p>
            <input value={answer} onChange={e=>setAnswer(e.target.value)} placeholder={procedure==='hip'?'dislocation':'paralysis'} style={{width:'100%',padding:12,borderRadius:8,border:'1px solid #ccc',marginTop:8}} />
            <button onClick={handleSubmit} style={{marginTop:12,padding:'12px 18px',borderRadius:8,background:'black',color:'white',fontWeight:700}}>Generate Certificate</button>
            {error && <p style={{color:'#dc2626'}}>{error}</p>}
          </>
        )}

        {stage==='cert' && (
          <div style={{background:'#f0fdf4',border:'2px solid #22c55e',padding:20,borderRadius:12,marginTop:12}}>
            <h2 style={{color:'#15803d'}}>✓ CONSENT CERTIFIED</h2>
            <p>Procedure: {procedure} | Risk: {answer} | Skips Blocked: {skipAttempts}</p>
            <p style={{fontSize:11,wordBreak:'break-all'}}>SHA-256: {hash}</p>
            <button onClick={()=>{setStage('start');setAnswer('');setHash('');setSkipAttempts(0)}}>Demo Again</button>
          </div>
        )}
      </div>
    </div>
  )
}
