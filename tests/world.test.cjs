const { test } = require('node:test');
const assert = require('node:assert/strict');
const World = require('../src/world.js');
const Campaign = require('../src/levels.js');
const Effects = require('../src/effects.js');

test('only training and five campaign levels are accepted', () => {
    assert.deepEqual(Campaign.levels.map(l => l.id), [0, 1, 2, 3, 4, 5]);
    for (const id of [-1, 6, 101, 102, NaN, '1']) assert.throws(() => Campaign.get(id), RangeError);
    assert.deepEqual(Campaign.levels.map(l => Object.values(l.mix).reduce((a, b) => a + b, 0)), [0, 10, 15, 18, 20, 0]);
});

test('layouts are seeded, connected, keep safe arrival and separate cover', () => {
    for (let level = 0; level <= 5; level++) {
        for (let seed = 1; seed <= 20; seed++) {
            const { walls, obstacles, nav } = Campaign.build(level, seed, World);
            assert.ok(nav.connected, `level ${level}, seed ${seed}`);
            assert.ok(!World.circleBlocked(150, 150, 26, walls));
            assert.equal(nav.nearest(150, 150) >= 0, true);
            assert.ok(obstacles.length <= Campaign.get(level).cover);
            for (const o of obstacles) assert.ok(!Campaign.reserved(o, 3600, 2200));
            const random = World.seeded(seed), occupied = [];
            for (let i = 0; i < 20; i++) {
                const p = World.spawn(nav, random, { x: 150, y: 150 }, 500, occupied);
                assert.ok(p, `spawn ${i} in level ${level}, seed ${seed}`);
                assert.ok(!World.circleBlocked(p.x, p.y, 26, walls));
                assert.ok(Math.hypot(p.x - 150, p.y - 150) >= 500);
                occupied.push({ ...p, radius: 22 });
            }
        }
        const a = Campaign.build(level, 123, World), b = Campaign.build(level, 123, World);
        assert.deepEqual(a.obstacles, b.obstacles);
    }
});

test('each combat floor has its own geometry; office keeps its previous layout', () => {
    for (const [a, b] of [[1, 2], [2, 3], [3, 4]]) {
        assert.notDeepEqual(Campaign.get(a).walls, Campaign.get(b).walls);
    }
    assert.equal(Campaign.get(2).walls.length, 6);
});

test('navigation routes a body around a long wall without teleporting or clipping', () => {
    const walls = [...Campaign.geometry(0, 800, 600), { x: 360, y: 30, width: 40, height: 390 }];
    const nav = World.navigation(800, 600, walls), body = { x: 180, y: 140, radius: 22 };
    const target = { x: 600, y: 140 };
    assert.ok(nav.connected);
    for (let i = 0; i < 900 && Math.hypot(body.x - target.x, body.y - target.y) > 8; i++) {
        const p = nav.waypoint(body.x, body.y, target.x, target.y);
        const dx = p.x - body.x, dy = p.y - body.y, distance = Math.hypot(dx, dy);
        if (distance) World.moveBody(body, dx / distance * Math.min(5, distance), dy / distance * Math.min(5, distance), walls);
        assert.ok(!World.circleBlocked(body.x, body.y, body.radius, walls));
    }
    assert.ok(Math.hypot(body.x - target.x, body.y - target.y) < 9, JSON.stringify(body));
});

test('axis sliding and substeps prevent thin-wall tunnelling', () => {
    const body = { x: 80, y: 80, radius: 10 }, walls = [{ x: 100, y: 0, width: 5, height: 300 }];
    World.moveBody(body, 100, 30, walls);
    assert.ok(body.x <= 90); assert.ok(body.y > 100);
});

test('swept geometry catches fast projectiles and reports the first hit', () => {
    const wall = { x: 50, y: 0, width: 5, height: 100 };
    assert.equal(World.segmentRect(0, 50, 200, 50, wall), 0.25);
    const victim = { x: 100, y: 50, radius: 10 };
    assert.ok(World.segmentCircle(0, 50, 200, 50, victim) > 0.25);
    assert.equal(World.segmentCircle(0, 0, 0, 0, victim), null);
    assert.equal(World.clearLine(0, 50, 200, 50, [wall]), false);
});

test('spawn failure is explicit instead of returning a blocked fallback', () => {
    const nav = World.navigation(200, 200, [{ x: 0, y: 0, width: 200, height: 200 }]);
    assert.equal(nav.connected, false);
    assert.equal(World.spawn(nav, World.seeded(1), { x: 0, y: 0 }), null);
});

test('cosmetic effects are bounded, expire, and clear on restart', () => {
    const fx = Effects.create(World.seeded(1));
    for (let i = 0; i < 500; i++) { fx.impact(1, 2, 3, 4); fx.trace(0, 0, 1, 1, '#fff'); }
    assert.equal(fx.particles.length, Effects.MAX_PARTICLES);
    assert.equal(fx.traces.length, Effects.MAX_TRACES);
    for (let i = 0; i < 25; i++) fx.update();
    assert.equal(fx.particles.length, 0); assert.equal(fx.traces.length, 0);
    fx.impact(1, 2, 0, 0); fx.reset(); assert.equal(fx.particles.length, 0);
});

test('a target hugging a wall remains anchored to the navigation graph', () => {
    const walls = Campaign.geometry(0, 800, 600), nav = World.navigation(800, 600, walls);
    // Player radius 15 can get closer to walls than the conservative 26px nav grid.
    assert.ok(nav.nearest(46, 150) >= 0);
    const step = nav.waypoint(500, 300, 46, 150);
    assert.ok(Number.isFinite(step.x) && Number.isFinite(step.y));
    assert.ok(Math.hypot(step.x - 500, step.y - 300) > 1);
});
