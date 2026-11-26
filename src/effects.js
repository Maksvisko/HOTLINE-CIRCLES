/* Bounded, cosmetic combat feedback. Never changes damage, hitboxes or game time. */
(function (root) {
    'use strict';
    const MAX_PARTICLES = 220, MAX_TRACES = 140;
    function create(random = Math.random) {
        const particles = [], traces = [];
        function impact(x, y, vx, vy, kind = 'wall', color = '#ffcf70') {
            const angle = Math.atan2(vy, vx) + Math.PI;
            const count = kind === 'wall' ? 5 : 8;
            for (let i = 0; i < count; i++) {
                const a = angle + (random() - 0.5) * 2.8, speed = 1.5 + random() * 4;
                const life = 9 + Math.floor(random() * 9);
                particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
                    life, maxLife: life, color: kind === 'wall' ? '#ffd58a' : color });
            }
            if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
        }
        function trace(x, y, tx, ty, color, enemy = false) {
            traces.push({ x, y, tx, ty, color, life: enemy ? 3 : 5, maxLife: enemy ? 3 : 5, enemy });
            if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
        }
        function update() {
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i]; p.x += p.vx; p.y += p.vy;
                p.vx *= 0.84; p.vy *= 0.84;
                if (--p.life <= 0) particles.splice(i, 1);
            }
            for (let i = traces.length - 1; i >= 0; i--) if (--traces[i].life <= 0) traces.splice(i, 1);
        }
        function draw(ctx, reduced = false) {
            ctx.save();
            ctx.lineCap = 'round';
            // No additive full-screen glow: enemy projectile heads remain dominant.
            for (const t of traces) {
                ctx.globalAlpha = (t.enemy ? 0.28 : 0.5) * t.life / t.maxLife;
                ctx.strokeStyle = t.color; ctx.lineWidth = t.enemy ? 1.5 : 2.5;
                ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(t.tx, t.ty); ctx.stroke();
            }
            for (let i = 0; i < particles.length; i++) {
                if (reduced && i % 2) continue;
                const p = particles[i];
                ctx.globalAlpha = p.life / p.maxLife; ctx.strokeStyle = p.color; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2, p.y - p.vy * 2); ctx.stroke();
            }
            ctx.restore();
        }
        function reset() { particles.length = 0; traces.length = 0; }
        return { impact, trace, update, draw, reset, particles, traces };
    }
    const api = { create, MAX_PARTICLES, MAX_TRACES };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CombatEffects = api;
})(globalThis);
