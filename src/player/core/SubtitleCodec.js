/** Normalize server codec aliases before routing or mapping subtitle tracks. */
export function normalizeSubtitleCodec(codec) {
    const value = String(codec || '').toLowerCase();
    return { hdmv_pgs_subtitle: 'pgssub', pgs: 'pgssub', srt: 'subrip' }[value] || value;
}
