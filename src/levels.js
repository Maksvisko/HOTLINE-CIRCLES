/* One campaign, independent floor plans. Office concept intentionally unchanged. */
(function (root) {
    'use strict';
    const levels = [
        { id: 0, ru: 'ОБУЧЕНИЕ', en: 'TRAINING', cover: 0, mix: {}, walls: [] },
        { id: 1, ru: 'СКЛАД', en: 'WAREHOUSE', cover: 24,
            mix: { melee: 6, ranged: 4 },
            // Staggered storage rows: a central route and two flanking routes.
            walls: [[640, 420, 520, 60], [640, 820, 520, 60],
                [1560, 620, 520, 60], [1560, 1120, 520, 60],
                [2480, 420, 500, 60], [2480, 1420, 500, 60]] },
        { id: 2, ru: 'ОФИС', en: 'OFFICE', cover: 22,
            mix: { melee: 5, ranged: 6, ambush: 4 },
            // Preserve the existing office geometry pending the author's redesign.
            walls: [[800, 300, 30, 500], [600, 600, 400, 30], [1500, 800, 30, 300],
                [500, 100, 30, 300], [1600, 600, 30, 400], [1000, 900, 400, 30]] },
        { id: 3, ru: 'ЗАВОД', en: 'FACTORY', cover: 30,
            mix: { melee: 4, ranged: 5, sniper: 5, ambush: 4 },
            walls: [[680, 340, 80, 620], [680, 1300, 80, 540],
                [1560, 600, 80, 920], [2440, 340, 80, 620],
                [2440, 1300, 80, 540], [2860, 1040, 400, 60]] },
        { id: 4, ru: 'ШТАБ', en: 'HQ', cover: 30,
            mix: { melee: 4, ranged: 4, sniper: 4, tank: 4, ambush: 4 },
            walls: [[600, 460, 680, 50], [600, 460, 50, 500],
                [1800, 360, 50, 600], [2300, 460, 640, 50],
                [1040, 1360, 50, 480], [1040, 1360, 620, 50],
                [2220, 1260, 50, 560], [2220, 1770, 660, 50]] },
        { id: 5, ru: 'БОСС', en: 'BOSS', cover: 0, mix: {}, walls: [] }
    ];
    function get(id) {
        if (!Number.isInteger(id) || !levels[id]) throw new RangeError('Unknown campaign level: ' + id);
        return levels[id];
    }
    function boundaries(width, height) {
        return [{ x: 0, y: 0, width, height: 30 }, { x: 0, y: height - 30, width, height: 30 },
            { x: 0, y: 0, width: 30, height }, { x: width - 30, y: 0, width: 30, height }];
    }
    function geometry(id, width, height) {
        return [...boundaries(width, height), ...get(id).walls.map(([x, y, width, height]) => ({ x, y, width, height }))];
    }
    // A clear arrival area and a 200px circulation loop always survive random cover.
    function reserved(rect, width, height) {
        const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
            a.y < b.y + b.height && a.y + a.height > b.y;
        return [{ x: 0, y: 0, width: 500, height: 500 },
            { x: 30, y: 30, width: width - 60, height: 190 },
            { x: 30, y: height - 220, width: width - 60, height: 190 },
            { x: 30, y: 30, width: 190, height: height - 60 },
            { x: width - 220, y: 30, width: 190, height: height - 60 }].some(r => overlap(rect, r));
    }
    function build(id, seed, World, width = 3600, height = 2200) {
        const definition = get(id), random = World.seeded(seed);
        const walls = geometry(id, width, height), obstacles = [];
        const styles = {
            1: { types: ['box', 'box', 'barrel', 'table'], colors: { box: '#7a4a22', barrel: '#4b4b4b', table: '#6a3e1e' } },
            2: { types: ['table', 'table', 'column', 'box'], colors: { table: '#2b3f6b', column: '#6c7a93', box: '#3a3a3a' } },
            3: { types: ['column', 'column', 'barrel', 'box'], colors: { column: '#556b5f', barrel: '#5a5a5a', box: '#5d4a2a' } },
            4: { types: ['box', 'column', 'barrel', 'table'], colors: { box: '#3a4a34', column: '#4a5450', barrel: '#3a3a3a', table: '#2b2f34' } }
        };
        const style = styles[id];
        for (let attempt = 0; style && attempt < 800 && obstacles.length < definition.cover; attempt++) {
            const sector = obstacles.length % 4;
            const w = 50 + Math.floor(random() * 70), h = 50 + Math.floor(random() * (id === 3 ? 150 : 70));
            const x = 260 + (sector % 2) * (width / 2 - 260) + random() * (width / 2 - 520 - w);
            const y = 260 + Math.floor(sector / 2) * (height / 2 - 260) + random() * (height / 2 - 520 - h);
            const rect = { x: Math.round(x), y: Math.round(y), width: w, height: h };
            if (reserved(rect, width, height)) continue;
            const padded = { x: rect.x - 100, y: rect.y - 100, width: w + 200, height: h + 200 };
            if (walls.some(o => padded.x < o.x + o.width && padded.x + padded.width > o.x &&
                padded.y < o.y + o.height && padded.y + padded.height > o.y)) continue;
            const type = style.types[Math.floor(random() * style.types.length)];
            obstacles.push({ ...rect, type, color: style.colors[type] }); walls.push(rect);
        }
        let nav = World.navigation(width, height, walls);
        // Reject cover which disconnects even a small part of the navigable grid.
        // Authored geometry is independently checked in the regression suite.
        while (!nav.connected && obstacles.length) {
            obstacles.pop(); walls.pop(); nav = World.navigation(width, height, walls);
        }
        if (!nav.connected) throw new Error('Disconnected authored layout: ' + id);
        return { walls, obstacles, nav };
    }
    const api = { levels, get, geometry, reserved, build };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Campaign = api;
})(globalThis);
