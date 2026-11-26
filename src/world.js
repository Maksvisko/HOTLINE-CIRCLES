/* Geometry and navigation shared by generation, spawning and movement.
   No DOM dependencies: the same implementation is exercised in Node tests. */
(function (root) {
    'use strict';
    function seeded(seed) {
        let state = seed >>> 0;
        return () => {
            state += 0x6D2B79F5;
            let t = Math.imul(state ^ state >>> 15, state | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    function circleBlocked(x, y, radius, walls) {
        return walls.some(w => {
            const dx = x - Math.max(w.x, Math.min(x, w.x + w.width));
            const dy = y - Math.max(w.y, Math.min(y, w.y + w.height));
            return dx * dx + dy * dy < radius * radius;
        });
    }

    // Slab intersection, expanded for projectile/body radius. Returns first contact.
    function segmentRect(x, y, tx, ty, rect, radius = 0) {
        let near = 0, far = 1;
        for (const [start, delta, low, high] of [
            [x, tx - x, rect.x - radius, rect.x + rect.width + radius],
            [y, ty - y, rect.y - radius, rect.y + rect.height + radius]
        ]) {
            if (Math.abs(delta) < 1e-9) {
                if (start < low || start > high) return null;
            } else {
                let a = (low - start) / delta, b = (high - start) / delta;
                if (a > b) [a, b] = [b, a];
                near = Math.max(near, a); far = Math.min(far, b);
                if (near > far) return null;
            }
        }
        return near;
    }

    function segmentCircle(x, y, tx, ty, target, radius = 0) {
        const dx = tx - x, dy = ty - y, ox = x - target.x, oy = y - target.y;
        const r = target.radius + radius, c = ox * ox + oy * oy - r * r;
        if (c <= 0) return 0;
        const a = dx * dx + dy * dy;
        if (!a) return null;
        const b = ox * dx + oy * dy, discriminant = b * b - a * c;
        if (discriminant < 0) return null;
        const t = (-b - Math.sqrt(discriminant)) / a;
        return t >= 0 && t <= 1 ? t : null;
    }

    function clearLine(x, y, tx, ty, walls, radius = 0) {
        return !walls.some(w => segmentRect(x, y, tx, ty, w, radius) !== null);
    }

    function moveBody(body, dx, dy, walls) {
        // Substeps prevent fast bodies from crossing thin geometry; axis sliding
        // avoids the old all-or-nothing diagonal movement against corners.
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 5));
        for (let i = 0; i < steps; i++) {
            if (!circleBlocked(body.x + dx / steps, body.y, body.radius, walls)) body.x += dx / steps;
            if (!circleBlocked(body.x, body.y + dy / steps, body.radius, walls)) body.y += dy / steps;
        }
    }

    function navigation(width, height, walls, radius = 26, cell = 40) {
        const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell), size = cols * rows;
        const open = new Uint8Array(size), links = Array.from({ length: size }, () => []);
        const point = id => ({ x: (id % cols + 0.5) * cell, y: (Math.floor(id / cols) + 0.5) * cell });
        for (let id = 0; id < size; id++) {
            const p = point(id);
            open[id] = p.x < width - radius && p.y < height - radius &&
                p.x > radius && p.y > radius && !walls.some(w =>
                    p.x >= w.x - radius && p.x <= w.x + w.width + radius &&
                    p.y >= w.y - radius && p.y <= w.y + w.height + radius) ? 1 : 0;
        }
        for (let id = 0; id < size; id++) {
            if (!open[id]) continue;
            for (const next of [id % cols < cols - 1 ? id + 1 : -1, id + cols < size ? id + cols : -1]) {
                if (next < 0 || !open[next]) continue;
                const a = point(id), b = point(next);
                if (clearLine(a.x, a.y, b.x, b.y, walls, radius)) {
                    links[id].push(next); links[next].push(id);
                }
            }
        }
        const cells = [];
        for (let id = 0; id < size; id++) if (open[id]) cells.push(id);
        function nearest(x, y) {
            const col = Math.max(0, Math.min(cols - 1, Math.floor(x / cell)));
            const row = Math.max(0, Math.min(rows - 1, Math.floor(y / cell)));
            const own = row * cols + col;
            if (open[own]) {
                const p = point(own);
                if (clearLine(x, y, p.x, p.y, walls, 0)) return own;
            }
            let best = -1, distance = Infinity;
            for (const id of cells) {
                const p = point(id), d = (p.x - x) ** 2 + (p.y - y) ** 2;
                if (d < distance && clearLine(x, y, p.x, p.y, walls, 0)) { distance = d; best = id; }
            }
            return best;
        }
        function distances(start) {
            const result = new Int32Array(size).fill(-1);
            if (start < 0) return result;
            const queue = [start]; result[start] = 0;
            for (let i = 0; i < queue.length; i++) {
                for (const id of links[queue[i]]) if (result[id] < 0) {
                    result[id] = result[queue[i]] + 1; queue.push(id);
                }
            }
            return result;
        }
        const initial = distances(cells[0] ?? -1);
        const connected = cells.length > 0 && cells.every(id => initial[id] >= 0);
        let targetCell = -2, field;
        function waypoint(x, y, tx, ty) {
            if (clearLine(x, y, tx, ty, walls, radius)) return { x: tx, y: ty };
            const goal = nearest(tx, ty), here = nearest(x, y);
            if (goal !== targetCell) { targetCell = goal; field = distances(goal); }
            if (here < 0 || field[here] < 0) return { x, y };
            // First reach our cell centre if a turn from our offset is obstructed.
            let next = here;
            for (const id of links[here]) if (field[id] >= 0 && field[id] < field[next]) {
                const p = point(id);
                if (clearLine(x, y, p.x, p.y, walls, radius)) next = id;
            }
            return point(next);
        }
        return { cells, point, nearest, distances, connected, waypoint, radius };
    }

    function spawn(nav, random, origin, minDistance = 300, occupied = [], region = null) {
        const candidates = nav.cells.filter(id => {
            const p = nav.point(id);
            return Math.hypot(p.x - origin.x, p.y - origin.y) >= minDistance &&
                (!region || p.x >= region.x && p.x <= region.x + region.width &&
                    p.y >= region.y && p.y <= region.y + region.height) &&
                occupied.every(o => Math.hypot(p.x - o.x, p.y - o.y) > (o.radius || 20) + 42);
        });
        if (!candidates.length) return null; // Never return an invalid last random attempt.
        return nav.point(candidates[Math.floor(random() * candidates.length)]);
    }

    const api = { seeded, circleBlocked, segmentRect, segmentCircle, clearLine, moveBody, navigation, spawn };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.GameWorld = api;
})(globalThis);
