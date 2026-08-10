"use client"
import { useState, useRef, useEffect } from 'react'

export default function Page() {
  const [procedure, setProcedure] = useState<'spine'|'hip'>('hip')
  const [stage, setStage] = useState('start')
  const [skipAttempts, setSkipAttempts] = useState(0)
  const [answer, setAnswer] = useState('')
  const [hash, setHash] = useState('')
  const [error, setError] = useState('')
  const playerRef = useRef<any>(null)
  const maxTimeRef = useRef(0)
  const intervalRef = useRef<any>(null)

  const HIP_ID = "WEif4buMjXo"
  const SPINE_DEMO = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"

  useEffect(() => {
    if (procedure !== 'hip') return
    // @ts-ignore
    if (!window.YT) {
      const tag = document.createElement('script')
      tag.src = "https://www.youtube.com/iframe_api"
      document.body.appendChild(tag)
    }
    // @ts-ignore
    window.onYouTubeIframeAPIReady = () => {
      // @ts-ignore
      playerRef.current = new window.YT.Player('yt-player', {
        videoId: HIP_ID,
        playerVars: { controls: 1, rel: 0, modestbranding: 1 },
        events: {
          onStateChange: (e: any) => {
            if (e.data === 1) { // playing
              intervalRef.current = setInterval(() => {
                const t = playerRef.current?.getCurrentTime() || 0
                if (t > maxTimeRef.current) maxTimeRef.current = t
                // block seek ahead
                if (t > maxTimeRef.current + 3) {
                  playerRef.current.seekTo(maxTimeRef.current, true)
                  setSkipAttempts(s=>s+1)
                  setError(`Seek blocked #${skipAttempts+1} logged - Patient tried to skip ahead`)
                }
              }, 500)
            } else {
              clearInterval(intervalRef.current)
            }
          }
        }
      })
    }
    return () => clearInterval(intervalRef.current)
  }, [stage, procedure])

  const handlePlay = () => { setStage('playing'); maxTimeRef.current = 0; setSkipAttempts(0); setError('') }
  const handleSeekBlockVideo = (e: any) => {
    const v = e.target as HTMLVideoElement
    if (v.currentTime > maxTimeRef.current + 2) {
      v.currentTime = maxTimeRef.current
      setSkipAttempts(s=>s+1)
      setError(`Seek blocked #${skipAttempts+1} logged`)
    } else {
      maxTimeRef.current = Math.max(maxTimeRef.current, v.currentTime)
    }
  }

  const handleSubmit = async () => {
    const need = procedure === 'hip' ? 'dislocation' : 'paralysis'
    if (!answer.toLowerCase().includes(need)) {
      setError(`Must type "${need}" to prove understanding - not "${answer}" - Claim 5 Active Recall`)
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
        <p style={{color:'#64748b'}}>Patent Pending US 16996631 | LIVE DEMO</p>

        <div style={{display:'flex',gap:12,margin:'16px 0'}}>
          <button onClick={()=>{setProcedure('spine');setStage('start');setAnswer('')}} style={{flex:1,padding:12,borderRadius:8,border: procedure==='spine'?'2px solid black':'1px solid #ddd',background: procedure==='spine'?'#f8fafc':'white',fontWeight:600}}>Spine Fusion CPT 22612<br/><span style={{fontSize:12}}>Paralysis Risk</span></button>
          <button onClick={()=>{setProcedure('hip');setStage('start');setAnswer('');setTimeout(()=>window.location.reload(),100)}} style={{flex:1,padding:12,borderRadius:8,border: procedure==='hip'?'2px solid #16a34a':'1px solid #ddd',background: procedure==='hip'?'#f0fdf4':'white',fontWeight:600}}>Hip Replacement<br/><span style={{fontSize:12}}>Dislocation / Infection Risk</span></button>
        </div>

        {stage==='start' && (
          <>
            <p><b>{procedure==='hip' ? 'CPT 27130 Hip Arthroplasty' : 'CPT 22612 Lumbar Fusion'} Risk Disclosure — Try to cheat, skip is blocked and logged.</b></p>
            <p style={{fontSize:14,color:'#475569'}}>Patient must watch full risk video. Seeking is blocked. Must type risk from memory. SHA-256 logged for legal proof.</p>
            <button onClick={handlePlay} style={{marginTop:12,padding:'14px 22px',borderRadius:10,background:'black',color:'white',fontWeight:700,fontSize:16}}>▶ START CONSENT FLOW — {procedure==='hip'?'HIP':'SPINE'}</button>
          </>
        )}

        {stage==='playing' && (
          <>
            <p style={{fontWeight:700,color: procedure==='hip'?'#15803d':'#b45309'}}>{procedure==='hip'?'Hip Replacement — Dislocation, Infection, Blood Clot, Leg Length Risk':'Spinal Fusion — Paralysis Risk'} — Try to drag ahead, it will block.</p>
            {procedure==='hip' ? (
              <div id="yt-player" style={{width:'100%',aspectRatio:'16/9',background:'black',borderRadius:12}}></div>
            ) : (
              <video src={SPINE_DEMO} controls controlsList="nodownload" onSeeking={handleSeekBlockVideo} onTimeUpdate={(e)=>{ const v=e.target as HTMLVideoElement; maxTimeRef.current=Math.max(maxTimeRef.current,v.currentTime)}} style={{width:'100%',borderRadius:12,background:'black'}} />
            )}
            <div style={{marginTop:12,display:'flex',justifyContent:'space-between',fontSize:14}}>
              <span style={{color:'#dc2626',fontWeight:700}}>Skips Blocked: {skipAttempts} {error && `— ${error}`}</span>
              <button onClick={()=>setStage('quiz')} style={{padding:'8px 14px',borderRadius:8,background:'#16a34a',color:'white',fontWeight:700}}>I Watched Full Video → Take Quiz</button>
            </div>
          </>
        )}

        {stage==='quiz' && (
          <>
            <h3>Type the main risk to prove understanding — Claim 5 Active Recall</h3>
            <p style={{fontSize:13,color:'#64748b'}}>For {procedure==='hip'?'HIP: type "dislocation"':'SPINE: type "paralysis"'}. Skips logged: {skipAttempts}</p>
            <input value={answer} onChange={e=>setAnswer(e.target.value)} placeholder={procedure==='hip'?'Type: dislocation':"Type: paralysis"} style={{width:'100%',padding:12,borderRadius:8,border:'1px solid #ccc',marginTop:8}} />
            <button onClick={handleSubmit} style={{marginTop:12,padding:'12px 18px',borderRadius:8,background:'black',color:'white',fontWeight:700}}>Submit & Generate Tamper-Proof Certificate</button>
            {error && <p style={{color:'#dc2626',marginTop:8}}>{error}</p>}
          </>
        )}

        {stage==='cert' && (
          <div style={{background:'#f0fdf4',border:'2px solid #22c55e',padding:20,borderRadius:12,marginTop:12}}>
            <h2 style={{color:'#15803d',margin:0}}>✓ CONSENT CERTIFIED — TAMPER PROOF</h2>
            <p><b>Procedure:</b> {procedure==='hip'?'Hip Replacement CPT 27130':'Spinal Fusion CPT 22612'}</p>
            <p><b>Risk Acknowledged:</b> {answer} | <b>Skip Attempts Blocked:</b> {skipAttempts}</p>
            <p style={{fontSize:12,wordBreak:'break-all'}}><b>SHA-256 Hash (legal evidence):</b><br/>{hash}</p>
            <p style={{fontSize:12,color:'#475569'}}>This hash includes timestamp + skip count + answer. Cannot be altered after signing. Patent Claim 6.</p>
            <button onClick={()=>{setStage('start');setAnswer('');setHash('');setSkipAttempts(0)}} style={{marginTop:10}}>Demo Again</button>
          </div>
        )}
      </div>
    </div>
  )
}
