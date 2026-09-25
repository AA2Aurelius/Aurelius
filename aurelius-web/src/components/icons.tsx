// Small line icons for the doctor portal (24px grid, current color).
const base = { className: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const PlayIcon = () => <svg {...base}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M10 9l5 3-5 3z" fill="currentColor" /></svg>;
export const UsersIcon = () => <svg {...base}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 010 7M18 14.8c1.8.8 3 2.6 3.5 5.2" /></svg>;
export const InviteIcon = () => <svg {...base}><circle cx="10" cy="8" r="3.5" /><path d="M3.5 20c.8-3.5 3.4-5.5 6.5-5.5 1.3 0 2.5.3 3.5 1" /><path d="M18 14v6M15 17h6" /></svg>;
export const LogoutIcon = () => <svg {...base}><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3" /><path d="M10 16l-4-4 4-4M6 12h10" /></svg>;
