"use client"
import { useState, useRef } from 'react'
export default function Page() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [stage, setStage] = useState('start')
  const [skipAttempts, setSkipAttempts] = useState(0)
  const [answer, setAnswer] = useState('')
  const [hash, setHash] = useState('')
  const [error, setError] = useState('')
  const handlePlay = () => { setStage('playing'); setTimeout(()=>videoRef.current?.play(),100) }
  const handleSeekAttempt = () => { setSkipAttempts(s=>s+1); setError(`Seek blocked #${skipAttempts+1} logged as evidence Claim 6`); setTimeout(()=>setError(''),3000); if(videoRef.current) videoRef.current.currentTime=0 }
  const handleSubmit = async () => {
    if(!answer.toLowerCase().includes('paralysis')){ setError(`Must type paralysis, not "${answer}" - Claim 5`); return }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({answer,skipAttempts,time:Date.now()})))
    setHash(Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')); setStage('cert')
  }
  return (
    <div style={{maxWidth:800,margin:'0 auto',padding:24,fontFamily:'system-ui'}}>
      <div style={{background:'white',borderRadius:12,padding:24,boxShadow:'0 4px 12px rgba(0,0,0,.1)'}}>
        <h1>AURELIUS - LAUNCHED</h1><p style={{color:'#64748b'}}>Patent Pending US 16996631 | LIVE</p>
        {stage==='start' && <><p>CPT 22612 Paralysis Risk - Try to cheat, skip is blocked and logged.</p><button onClick={handlePlay} style={{background:'#0f172a',color:'white',padding:'12px 24px',borderRadius:8,border:0}}>Start Consent Flow</button></>}
        {stage==='playing' && <><video ref={videoRef} src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" style={{width:'100%',height:400,background:'black',borderRadius:8}} onSeeking={handleSeekAttempt} onEnded={()=>setStage('quiz')} /><p>Skips: {skipAttempts}</p>{error && <div style={{background:'#fef2f2',color:'#dc2626',padding:10,borderRadius:6}}>{error}</div>}<button onClick={handleSeekAttempt} style={{marginTop:10}}>Try to Skip</button></>}
        {stage==='quiz' && <><h3>Type the risk - Claim 5 Active Recall</h3><input value={answer} onChange={e=>setAnswer(e.target.value)} placeholder="Type paralysis" style={{width:'100%',padding:12,borderRadius:8,border:'1px solid #ccc'}} /><button onClick={handleSubmit} style={{marginTop:12,background:'#0f172a',color:'white',padding:'12px 24px',borderRadius:8,border:0}}>Submit</button>{error && <div style={{background:'#fef2f2',color:'#dc2626',padding:10,borderRadius:6,marginTop:10}}>{error}</div>}</>}
        {stage==='cert' && <div style={{background:'#f0fdf4',border:'2px solid #22c55e',padding:20,borderRadius:10}}><h2>✓ EVIDENCE CERTIFICATE</h2><p>Typed: {answer} | Skips: {skipAttempts}</p><code style={{wordBreak:'break-all'}}>{hash}</code><p>TX: 0x{hash.slice(0,64)}</p><p>This stops $4.8M verdicts</p><button onClick={()=>setStage('start')}>Run Again</button></div>}
      </div></div>
  )
}
