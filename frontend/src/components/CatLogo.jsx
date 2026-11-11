import { useEffect, useRef } from 'react'

export default function CatLogo({
  size = 112,
  interactive = true,
  className = '',
  style = {},
}) {
  const svgRef = useRef(null)
  const eyesRef = useRef(null)
  const screenRef = useRef(null)

  useEffect(() => {
    if (!interactive) return
    const svg = svgRef.current
    const eyes = eyesRef.current
    const screen = screenRef.current
    if (!svg || !eyes || !screen) return

    const RADIUS = 350
    const MAX_MOVE = 12

    let rafId = null

    const handleMouseMove = (e) => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        if (!svgRef.current || !eyesRef.current || !screenRef.current) return
        const rect = svgRef.current.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height * 0.58
        const dx = e.clientX - centerX
        const dy = e.clientY - centerY
        const dist = Math.hypot(dx, dy)

        if (dist < RADIUS) {
          const angle = Math.atan2(dy, dx)
          const power = Math.min(dist / (RADIUS * 0.45), 1)
          const moveX = Math.cos(angle) * MAX_MOVE * power
          const moveY = Math.sin(angle) * (MAX_MOVE * 0.8) * power
          eyesRef.current.style.transform = `translate(${moveX.toFixed(1)}px, ${moveY.toFixed(1)}px)`
          screenRef.current.style.transform = `translate(${(moveX * 0.2).toFixed(1)}px, ${(moveY * 0.2).toFixed(1)}px)`
        } else {
          eyesRef.current.style.transform = 'translate(0px, 0px)'
          screenRef.current.style.transform = 'translate(0px, 0px)'
        }
      })
    }

    window.addEventListener('mousemove', handleMouseMove, { passive: true })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('mousemove', handleMouseMove)
    }
  }, [interactive])

  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-15 -15 270 270"
      width={size}
      height={size}
      className={`cat-logo ${className}`.trim()}
      style={{ overflow: 'visible', display: 'inline-block', flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {/* Белая внешняя обводка для темного фона */}
      <g
        stroke="#FFFFFF"
        strokeWidth="35"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M 42 75 C 52 28, 70 14, 78 14 C 86 14, 100 32, 112 68 Z" />
        <path d="M 128 68 C 140 32, 154 14, 162 14 C 170 14, 188 28, 198 75 Z" />
        <path d="M 42 72 C 90 56, 150 56, 198 72 C 212 115, 214 165, 200 202 C 188 220, 160 224, 120 224 C 80 224, 52 220, 40 202 C 26 165, 28 115, 42 72 Z" />
      </g>
      {/* Левое и правое ухо */}
      <path
        d="M 42 75 C 52 28, 70 14, 78 14 C 86 14, 100 32, 112 68 Z"
        fill="#CAE6E5"
        stroke="#000000"
        strokeWidth="15"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M 128 68 C 140 32, 154 14, 162 14 C 170 14, 188 28, 198 75 Z"
        fill="#CAE6E5"
        stroke="#000000"
        strokeWidth="15"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Корпус */}
      <path
        d="M 42 72 C 90 56, 150 56, 198 72 C 212 115, 214 165, 200 202 C 188 220, 160 224, 120 224 C 80 224, 52 220, 40 202 C 26 165, 28 115, 42 72 Z"
        fill="#FAF6F0"
        stroke="#000000"
        strokeWidth="15"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Экран */}
      <path
        ref={screenRef}
        style={{ transition: 'transform 0.25s ease-out' }}
        d="M 68 96 C 100 88, 140 88, 172 96 C 180 125, 180 160, 172 184 C 140 190, 100 190, 68 184 C 60 160, 60 125, 68 96 Z"
        fill="#CAE6E5"
        stroke="#000000"
        strokeWidth="11"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Глаза */}
      <g ref={eyesRef} style={{ transition: 'transform 0.15s ease-out' }}>
        <ellipse cx="90" cy="144" rx="10.5" ry="9.5" fill="#000000" />
        <ellipse cx="150" cy="144" rx="10" ry="9.5" fill="#000000" />
      </g>
    </svg>
  )
}
