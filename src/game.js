
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        // roundRect polyfill (Safari/older)
        if (!CanvasRenderingContext2D.prototype.roundRect) {
            CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
                const rr = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : { tl: 0, tr: 0, br: 0, bl: 0, ...r };
                this.beginPath();
                this.moveTo(x + rr.tl, y);
                this.lineTo(x + w - rr.tr, y);
                this.quadraticCurveTo(x + w, y, x + w, y + rr.tr);
                this.lineTo(x + w, y + h - rr.br);
                this.quadraticCurveTo(x + w, y + h, x + w - rr.br, y + h);
                this.lineTo(x + rr.bl, y + h);
                this.quadraticCurveTo(x, y + h, x, y + h - rr.bl);
                this.lineTo(x, y + rr.tl);
                this.quadraticCurveTo(x, y, x + rr.tl, y);
                return this;
            };
        }
        const WORLD_WIDTH = 3600, WORLD_HEIGHT = 2200;
        canvas.width = 1920; canvas.height = 1080;

        let gameState = 'menu', currentLevel = 1, selectedLevel = 1, kills = 0, totalEnemies = 0, weaponSpawnTimer = 0, selectedCharacter = 'standard';
        let hardMode = false, hardModeProgress = 1, medkitUsed = false;

        // Chapter 2 (story levels with fixed characters)
        let chapter2Active = false;
        let chapter2Level = 0;
        const camera = { x: 0, y: 0, shakeX: 0, shakeY: 0, shakeDuration: 0, shakePower: 10 };
        const player = { x: 100, y: 100, radius: 15, speed: 7, hp: 100, maxHP: 100, color: '#ff0000', weapon: 'pistol', startingWeapon: 'pistol', hasTopLine: false, lastHpThreshold: 100 };

        // Chapter 2 fixed character (HoTRoD)
        const meshCharacter = {
            key: 'mesh',
            name: 'Jack',
            hp: 125,
            maxHP: 125,
            color: '#0b0b0b',
            radius: 15,
            speed: 7,
            startingWeapon: 'mesh_dual'
        };
        let currentLanguage = 'ru';

        const weapons = {
            pistol: { name: 'Пистолет', damage: 25, fireRate: 300, ammo: Infinity, bulletSpeed: 10, color: '#ffff00', sound: 'pew', type: 'ranged' },
            shotgun: { name: 'Дробовик', damage: 25, fireRate: 700, ammo: 12, bulletSpeed: 11, color: '#ff8800', spread: 5, sound: 'boom', type: 'ranged' },
            rifle: { name: 'Винтовка', damage: 25, fireRate: 120, ammo: 45, bulletSpeed: 15, color: '#00ffff', sound: 'tak', type: 'ranged' },
            smg: { name: 'SMG', damage: 10, fireRate: 80, ammo: 100, bulletSpeed: 12, color: '#00ff00', sound: 'brr', type: 'ranged' },
            sniper: { name: 'Снайперка', damage: 100, fireRate: 3000, ammo: 8, bulletSpeed: 25, color: '#ff00ff', sound: 'snipe', type: 'ranged' },
            machete: { name: 'Рубака', damage: 40, fireRate: 400, ammo: Infinity, range: 80, color: '#9933FF', sound: 'slice', type: 'melee' },

            // Chapter 2: Jack dual pistols (infinite ammo)
            mesh_dual: { name: 'Два пистолета', damage: 10, fireRate: 170, ammo: Infinity, bulletSpeed: 12, color: '#d1d5db', sound: 'pew', type: 'ranged', dual: true },

            // Chapter 2: Skyler SMG burst (3 rounds per click)
            skyler_burst: { name: 'ПП (Burst)', damage: 12, fireRate: 320, ammo: Infinity, bulletSpeed: 13, color: '#a855f7', sound: 'brr', type: 'ranged', burst: 3, burstDelay: 70 },

            // Secret character weapon
            // NOTE: damage is per "tick" (fireRate = 50ms). 1.5 * 20 ticks/sec = 30 HP per second.
            // consumeEvery: spend 1 ammo every N ticks (keeps 100 ammo usable for longer).
            flamethrower: { name: 'Огнемет', damage: 1.5, fireRate: 50, ammo: 100, range: 320, cone: 0.55, consumeEvery: 3, color: '#ff7a00', sound: 'flame', type: 'flame' }
        };

        let currentWeapon = weapons.pistol, canShoot = true, macheteSlash = null;
        let abilityAvailable = true, abilityActive = false, abilityTimer = 0, originalFireRate = 0, originalMacheteRange = 80;

        // Per-run weapon state (ammo etc.) so switching doesn't reset to defaults
        let playerWeaponsState = {}; // { weaponType: { ...weaponData, ammo, _consumeAcc? } }
        function ensureWeaponState(type) {
            if (!playerWeaponsState[type]) {
                // clone from base weapons definition
                playerWeaponsState[type] = { ...weapons[type] };
            }
            return playerWeaponsState[type];
        }
        function equipWeapon(type) {
            // save current state back (currentWeapon is already a reference-like object)
            if (player.weapon && currentWeapon) {
                playerWeaponsState[player.weapon] = { ...currentWeapon };
            }
            player.weapon = type;
            currentWeapon = { ...ensureWeaponState(type) };
            updateHUD();
        }
        let enemies = [], bullets = [], enemyBullets = [], weaponPickups = [], walls = [], obstacles = [], boss = null, miniBoss = null, mainEnemiesDefeated = false;
        let enemyIdCounter = 1;
        let graffiti = [];

        // HoTRoD: explosive barrels (3 hits -> boom)
        let explosiveBarrels = []; // stored as obstacle objects

        // Flamethrower fuel pickups (spawn when flamethrower hits 0)
        let flameFuelPickups = []; // { x,y,radius, amount }
        let flameFuelSpawnedThisZero = false;

        // Flamethrower visuals
        let flameParticles = [];
        let flameHeat = []; // lingering heat spots (visual only)
        let flameAimAngle = 0;

        // Pyro ability: fire aura circle
        let pyroAura = {
            active: false,
            radius: 160,
            dps: 18,           // damage per second to enemies in circle
            ammoPerSec: 10,    // flamethrower fuel regen per second
            t: 0,
            tickAcc: 0
        };

        // MESH grenades (Chapter 2)
        let meshGrenades = [];

        // Skyler dash ability
        let skylerDash = {
            active: false,
            t: 0,
            duration: 10,      // короткий рывок, как было изначально
            vx: 0,
            vy: 0,
            cooldown: 0,
            cooldownMax: 180,   // 3 seconds at 60fps
            invulnT: 0          // таймер неуязвимости Skyler (в кадрах)
        };

        // Chapter 2: grenade pickups (ammo for MESH ability)
        let grenadePickups = []; // {x,y,radius, amount}
        let meshGrenadeCount = 0;
        let grenadeSpawnTimer = 0;
        const HOTROD_GRENADE_SPAWN_EVERY = 420; // frames (~7s)

        // HoTRoD wave: spawn 5 miniganer only at the end
        let hotrodFinalWaveSpawned = false;

        // HoTRoD intro cutscene state
        let hotrodIntroPending = false;
        let hotrodCutscene = {
            active: false,
            stage: 0,
            stageT: 0,
            // stage 0: Jack enters (camera follows)
            // stage 1: wide shot (camera pans)
            // stage 2: SHOW TIME
            camFromX: 0,
            camFromY: 0,
            camToX: 0,
            camToY: 0
        };

        // Explosion visuals
        let shockwaves = []; // {x,y,r,vr,life,maxLife,color}
        let screenFlash = 0; // 0..1
        let scorchMarks = []; // {x,y,r,life,maxLife,blots:[{a,d,r}]}

        // Simple muzzle flashes (visual only)
        let muzzleFlashes = []; // {x,y,life,maxLife,angle}

        // Skyward Ascent decorations (no collision)
        let skywardDecor = { buildings: [], bridges: [] };
        // Skyward Ascent walkable zones (used to prevent walking in gaps / off rooftops)
        let skywardWalkZones = []; // {x,y,w,h}
        let skywardLastSafe = { x: 0, y: 0 };

        let levelTheme = { floorA: '#1a1a1a', floorB: '#141414', grid: '#2a2a2a', ambient: null };
        let tutorialStage = 0, tutorialTargets = [];
        let pyroTutorialStartAmmo = null;

        function updateMeshGrenades() {
            for (let i = meshGrenades.length - 1; i >= 0; i--) {
                const g = meshGrenades[i];
                
                // Move grenade
                g.x += g.vx;
                g.y += g.vy;
                
                // Friction
                g.vx *= 0.98;
                g.vy *= 0.98;
                
                // Bounce off walls
                let bounced = false;
                for (const w of walls) {
                    const closestX = Math.max(w.x, Math.min(g.x, w.x + w.width));
                    const closestY = Math.max(w.y, Math.min(g.y, w.y + w.height));
                    const dx = g.x - closestX;
                    const dy = g.y - closestY;
                    if (dx * dx + dy * dy < g.radius * g.radius) {
                        // Reflect velocity
                        const len = Math.hypot(dx, dy);
                        if (len > 0) {
                            const nx = dx / len, ny = dy / len;
                            const dot = g.vx * nx + g.vy * ny;
                            g.vx -= 2 * dot * nx * 0.7;
                            g.vy -= 2 * dot * ny * 0.7;
                            // Push out
                            g.x = closestX + nx * (g.radius + 1);
                            g.y = closestY + ny * (g.radius + 1);
                        }
                        bounced = true;
                        break;
                    }
                }
                
                // Timer countdown
                g.timer--;
                
                // Explode when timer reaches 0
                if (g.timer <= 0) {
                    explodeMeshGrenade(g);
                    meshGrenades.splice(i, 1);
                }
            }
        }

        function addScorch(x, y, r = 92) {
            const maxLife = 520; // ~8-9 seconds
            const blots = [];
            const n = 8 + Math.floor(Math.random() * 8);
            for (let i = 0; i < n; i++) {
                blots.push({
                    a: Math.random() * Math.PI * 2,
                    d: Math.random() * r * 0.55,
                    r: 10 + Math.random() * (r * 0.28)
                });
            }
            scorchMarks.push({ x, y, r: r * (0.85 + Math.random() * 0.35), life: maxLife, maxLife, blots });
            if (scorchMarks.length > 26) scorchMarks.splice(0, scorchMarks.length - 26);
        }

        function explodeMeshGrenade(g) {
            const radius = g.explosionRadius;
            const damage = g.damage;
            
            // Damage enemies
            for (let i = enemies.length - 1; i >= 0; i--) {
                const e = enemies[i];
                if (Math.hypot(e.x - g.x, e.y - g.y) <= radius + e.radius) {
                    e.hp -= damage;
                    if (e.hp <= 0) {
                        enemies.splice(i, 1);
                        kills++;
                    }
                }
            }
            
            // Damage miniboss
            if (miniBoss && Math.hypot(miniBoss.x - g.x, miniBoss.y - g.y) <= radius + miniBoss.radius) {
                miniBoss.hp -= damage;
                if (miniBoss.hp <= 0) miniBossDefeated();
                else updateMiniBossHealthBar();
            }
            
            // Damage boss
            if (boss && Math.hypot(boss.x - g.x, boss.y - g.y) <= radius + boss.radius) {
                boss.hp -= damage;
                if (boss.hp <= 0) bossDefeated();
                else updateBossHealthBar();
            }
            
            // Damage player
            if (Math.hypot(player.x - g.x, player.y - g.y) <= radius + player.radius) {
                // Tank shield OR Skyler dash grant full damage immunity
                if (!(abilityActive && selectedCharacter === 'tank') && !(selectedCharacter === 'skyler' && skylerDash.invulnT > 0)) {
                    player.hp -= damage;
                    updateHUD();
                }
            }
            
            // Destroy obstacles (not walls)
            for (let i = obstacles.length - 1; i >= 0; i--) {
                const o = obstacles[i];
                const ox = o.x + o.width / 2;
                const oy = o.y + o.height / 2;
                if (Math.hypot(ox - g.x, oy - g.y) <= radius + Math.max(o.width, o.height) / 2) {
                    obstacles.splice(i, 1);
                    // Remove from walls array too
                    for (let j = walls.length - 1; j >= 0; j--) {
                        if (walls[j].x === o.x && walls[j].y === o.y && walls[j].width === o.width && walls[j].height === o.height) {
                            walls.splice(j, 1);
                            break;
                        }
                    }
                }
            }
            
            // Camera shake + flash
            camera.shakeDuration = Math.max(camera.shakeDuration || 0, 28);
            camera.shakePower = Math.max(camera.shakePower || 10, 16);
            screenFlash = Math.max(screenFlash, 0.55);
            shockwaves.push({ x: g.x, y: g.y, r: 10, vr: 26, life: 18, maxLife: 18, color: 'rgba(255,180,80,0.9)' });
            addScorch(g.x, g.y, 95);

            // Visual explosion particles
            for (let j = 0; j < 34; j++) {
                const a = Math.random() * Math.PI * 2;
                const sp = 4 + Math.random() * 8;
                flameParticles.push({
                    x: g.x,
                    y: g.y,
                    vx: Math.cos(a) * sp,
                    vy: Math.sin(a) * sp,
                    r: 9 + Math.random() * 15,
                    life: 18 + Math.floor(Math.random() * 22),
                    maxLife: 44,
                    heat: 1
                });
            }
            if (flameParticles.length > 520) flameParticles.splice(0, flameParticles.length - 520);
        }

        function explodeBarrel(o) {
            if (!o) return;
            const cx = o.x + o.width / 2;
            const cy = o.y + o.height / 2;
            const radius = o.explosionRadius || 140;
            const damage = o.damage || 100;

            // Remove the barrel itself from obstacles + its collider
            for (let i = obstacles.length - 1; i >= 0; i--) {
                if (obstacles[i] === o) {
                    obstacles.splice(i, 1);
                    break;
                }
            }
            for (let j = walls.length - 1; j >= 0; j--) {
                if (walls[j].x === o.x && walls[j].y === o.y && walls[j].width === o.width && walls[j].height === o.height) {
                    walls.splice(j, 1);
                    break;
                }
            }

            // Damage enemies
            for (let i = enemies.length - 1; i >= 0; i--) {
                const e = enemies[i];
                if (Math.hypot(e.x - cx, e.y - cy) <= radius + e.radius) {
                    e.hp -= damage;
                    if (e.hp <= 0) {
                        enemies.splice(i, 1);
                        kills++;
                    }
                }
            }

            // Damage player
            if (Math.hypot(player.x - cx, player.y - cy) <= radius + player.radius) {
                // Tank shield OR Skyler dash grant full damage immunity
                if (!(abilityActive && selectedCharacter === 'tank') && !(selectedCharacter === 'skyler' && skylerDash.invulnT > 0)) {
                    player.hp -= damage;
                    updateHUD();
                }
            }

            // Destroy nearby obstacles (props). We remove both from `obstacles` and their matching collider in `walls`.
            // This does NOT remove the room's wall-segments unless they are represented as obstacles (they aren't).
            for (let i = obstacles.length - 1; i >= 0; i--) {
                const ob = obstacles[i];
                // don't chain-explode other explosive barrels by removing them; they can be hit separately
                const ox = ob.x + ob.width / 2;
                const oy = ob.y + ob.height / 2;
                if (Math.hypot(ox - cx, oy - cy) <= radius + Math.max(ob.width, ob.height) / 2) {
                    obstacles.splice(i, 1);
                    // Remove collider for destroyed obstacle (if exists)
                    for (let j = walls.length - 1; j >= 0; j--) {
                        if (walls[j].x === ob.x && walls[j].y === ob.y && walls[j].width === ob.width && walls[j].height === ob.height) {
                            walls.splice(j, 1);
                            break;
                        }
                    }
                }
            }

            camera.shakeDuration = Math.max(camera.shakeDuration || 0, 34);
            camera.shakePower = Math.max(camera.shakePower || 10, 20);
            screenFlash = Math.max(screenFlash, 0.7);
            shockwaves.push({ x: cx, y: cy, r: 12, vr: 30, life: 20, maxLife: 20, color: 'rgba(255,80,0,0.95)' });
            addScorch(cx, cy, 110);

            // Explosion particles
            for (let j = 0; j < 46; j++) {
                const a = Math.random() * Math.PI * 2;
                const sp = 4.2 + Math.random() * 9.5;
                flameParticles.push({
                    x: cx,
                    y: cy,
                    vx: Math.cos(a) * sp,
                    vy: Math.sin(a) * sp,
                    r: 10 + Math.random() * 18,
                    life: 18 + Math.floor(Math.random() * 26),
                    maxLife: 52,
                    heat: 1
                });
            }
            if (flameParticles.length > 520) flameParticles.splice(0, flameParticles.length - 520);
        }

        function updateFlame() {
            if (flameParticles.length) {
                for (let i = flameParticles.length - 1; i >= 0; i--) {
                    const p = flameParticles[i];
                    p.x += p.vx;
                    p.y += p.vy;
                    // light drag + upward lick
                    p.vx *= 0.94;
                    p.vy *= 0.94;
                    p.vy -= 0.03;
                    p.life--;
                    p.r *= 0.97;
                    if (p.life <= 0 || p.r < 0.8) flameParticles.splice(i, 1);
                }
            }

            if (flameHeat.length) {
                for (let i = flameHeat.length - 1; i >= 0; i--) {
                    const h = flameHeat[i];
                    h.life--;
                    h.r *= 0.985;
                    if (h.life <= 0 || h.r < 6) flameHeat.splice(i, 1);
                }
            }
        }

        function drawFlame() {
            // Draw heat first (below particles)
            if (flameHeat.length) {
                ctx.save();
                ctx.globalCompositeOperation = 'source-over';
                for (const h of flameHeat) {
                    const a = Math.max(0, Math.min(1, h.life / h.maxLife));
                    const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.r);
                    g.addColorStop(0, `rgba(255, 180, 70, ${0.12 * a})`);
                    g.addColorStop(0.45, `rgba(255, 80, 0, ${0.09 * a})`);
                    g.addColorStop(1, 'rgba(255, 0, 0, 0)');
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }

            if (!flameParticles.length) return;

            ctx.save();
            // Soft additive look but cheap: use lighter only for a few particles (still ok in 2D canvas)
            ctx.globalCompositeOperation = 'lighter';

            for (const p of flameParticles) {
                const a = Math.max(0, Math.min(1, p.life / p.maxLife));
                const outer = p.r * 1.6;
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, outer);
                g.addColorStop(0, `rgba(255, 255, 220, ${0.22 * a})`);
                g.addColorStop(0.25, `rgba(255, 190, 70, ${0.25 * a})`);
                g.addColorStop(0.6, `rgba(255, 90, 0, ${0.17 * a})`);
                g.addColorStop(1, 'rgba(120, 0, 0, 0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(p.x, p.y, outer, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        }
        const tutorialTextElement = document.getElementById('tutorialText');
        const keys = {}, mouse = { x: 0, y: 0, worldX: 0, worldY: 0, clicked: false };
        let audioContext, musicEnabled = true, musicIntervals = [], masterGain = null;
        const menuMusic = document.getElementById('menuMusic');
        const level1Music = document.getElementById('level1Music');
        const level2Music = document.getElementById('level2Music');
        const level3Music = document.getElementById('level3Music');
        const level4Music = document.getElementById('level4Music');
        const bossMusic = document.getElementById('bossMusic');
        let menuMusicStarted = false;

        const gameDialog = document.getElementById('gameDialog');
        const gameDialogTitle = document.getElementById('gameDialogTitle');
        const gameDialogText = document.getElementById('gameDialogText');
        const gameDialogInput = document.getElementById('gameDialogInput');
        const gameDialogOk = document.getElementById('gameDialogOk');
        const gameDialogCancel = document.getElementById('gameDialogCancel');
        let dialogResolve = null;
        let dialogReject = null;
        let dialogIsPrompt = false;

        // HUD animation helpers
        const hudHP = document.getElementById('hudHP');
        const hudAmmo = document.getElementById('hudAmmo');
        let prevHudHP = null;
        let prevHudAmmo = null;

        function hudPulse(el, type = 'pop') {
            if (!el) return;
            el.classList.remove(type);
            void el.offsetWidth;
            el.classList.add(type);
            setTimeout(() => el.classList.remove(type), 400);
        }

        function showGameAlert(text, title = 'Сообщение') {
            return new Promise((resolve) => {
                dialogIsPrompt = false;
                gameDialogTitle.textContent = title;
                gameDialogText.textContent = text;
                gameDialogInput.style.display = 'none';
                gameDialogCancel.style.display = 'none';
                gameDialog.style.display = 'flex';
                dialogResolve = resolve;
                dialogReject = null;
            });
        }

        function showGamePrompt(text, title = 'Ввод') {
            return new Promise((resolve, reject) => {
                dialogIsPrompt = true;
                gameDialogTitle.textContent = title;
                gameDialogText.textContent = text;
                gameDialogInput.style.display = 'block';
                gameDialogInput.value = '';
                gameDialogCancel.style.display = 'inline-block';
                gameDialog.style.display = 'flex';
                gameDialogInput.focus();
                dialogResolve = resolve;
                dialogReject = reject;
            });
        }

        gameDialogOk.addEventListener('click', () => {
            if (dialogIsPrompt) {
                const value = gameDialogInput.value;
                if (dialogResolve) dialogResolve(value);
            } else {
                if (dialogResolve) dialogResolve();
            }
            gameDialog.style.display = 'none';
        });

        gameDialogCancel.addEventListener('click', () => {
            if (dialogIsPrompt) {
                if (dialogReject) dialogReject(null);
            }
            gameDialog.style.display = 'none';
        });

        gameDialogInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                gameDialogOk.click();
            }
        });

        /* =======================
           Neon Miami 2D menu background
        ======================= */
        const menuBg = document.getElementById('menuBg');
        const mctx = menuBg.getContext('2d');
        let menuBgT = 0;
        const stars = Array.from({ length: 140 }, () => ({
            x: Math.random(),
            y: Math.random(),
            r: 0.2 + Math.random() * 1.7,
            p: Math.random() * Math.PI * 2,
            s: 0.5 + Math.random() * 1.6
        }));

        function resizeMenuBg() {
            const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
            menuBg.width = Math.floor(window.innerWidth * dpr);
            menuBg.height = Math.floor(window.innerHeight * dpr);
            menuBg.style.width = window.innerWidth + 'px';
            menuBg.style.height = window.innerHeight + 'px';
            mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        window.addEventListener('resize', resizeMenuBg);
        resizeMenuBg();

        function setMenuBgVisible(visible) {
            menuBg.style.opacity = visible ? '1' : '0';
        }

        function drawMenuBg() {
            menuBgT += 1 / 60;

            const w = window.innerWidth;
            const h = window.innerHeight;

            // Only animate while in menus; keep it lightweight otherwise
            const menuVisible = (gameState === 'menu');
            setMenuBgVisible(menuVisible);
            if (!menuVisible) {
                requestAnimationFrame(drawMenuBg);
                return;
            }

            // Background gradient
            const g = mctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, '#04040c');
            g.addColorStop(0.55, '#090928');
            g.addColorStop(1, '#020208');
            mctx.fillStyle = g;
            mctx.fillRect(0, 0, w, h);

            // Subtle haze
            const haze = mctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.35, Math.max(w, h) * 0.8);
            haze.addColorStop(0, 'rgba(255, 0, 255, 0.06)');
            haze.addColorStop(0.55, 'rgba(0, 255, 255, 0.05)');
            haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
            mctx.fillStyle = haze;
            mctx.fillRect(0, 0, w, h);

            // Stars
            for (const s of stars) {
                const tw = 0.55 + 0.45 * Math.sin(menuBgT * s.s * 1.25 + s.p);
                mctx.globalAlpha = tw;
                mctx.fillStyle = 'rgba(255,255,255,0.95)';
                const x = s.x * w;
                const y = s.y * h * 0.7;
                mctx.beginPath();
                mctx.arc(x, y, s.r, 0, Math.PI * 2);
                mctx.fill();
            }
            mctx.globalAlpha = 1;

            // Neon sun
            const sunX = w * 0.72;
            const sunY = h * 0.28;
            const sunR = Math.min(w, h) * 0.16;
            const sunGrad = mctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
            sunGrad.addColorStop(0, 'rgba(255, 230, 140, 0.95)');
            sunGrad.addColorStop(0.35, 'rgba(255, 80, 200, 0.85)');
            sunGrad.addColorStop(1, 'rgba(255, 0, 255, 0.0)');
            mctx.fillStyle = sunGrad;
            mctx.beginPath();
            mctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
            mctx.fill();

            // Sun scanlines
            mctx.save();
            mctx.beginPath();
            mctx.arc(sunX, sunY, sunR * 0.75, 0, Math.PI * 2);
            mctx.clip();
            mctx.globalAlpha = 0.25;
            for (let y = -sunR; y < sunR; y += 6) {
                const yy = sunY + y;
                mctx.fillStyle = y % 12 === 0 ? 'rgba(0,255,255,0.16)' : 'rgba(0,0,0,0.12)';
                mctx.fillRect(sunX - sunR, yy, sunR * 2, 2);
            }
            mctx.restore();
            mctx.globalAlpha = 1;

            // Horizon & grid
            const horizonY = h * 0.62;
            const vanishX = w * 0.5;

            // Horizon glow
            const hz = mctx.createLinearGradient(0, horizonY - 80, 0, horizonY + 120);
            hz.addColorStop(0, 'rgba(255,0,255,0)');
            hz.addColorStop(0.45, 'rgba(255,0,255,0.16)');
            hz.addColorStop(0.6, 'rgba(0,255,255,0.14)');
            hz.addColorStop(1, 'rgba(0,0,0,0)');
            mctx.fillStyle = hz;
            mctx.fillRect(0, horizonY - 80, w, 220);

            // Grid lines (2D perspective illusion)
            mctx.lineWidth = 1;
            mctx.globalAlpha = 0.75;

            // Vertical rays
            const rays = 22;
            for (let i = -rays; i <= rays; i++) {
                const x = vanishX + i * (w / (rays * 2)) * 1.2;
                mctx.strokeStyle = i % 2 === 0 ? 'rgba(0, 255, 255, 0.35)' : 'rgba(255, 0, 255, 0.22)';
                mctx.beginPath();
                mctx.moveTo(vanishX, horizonY);
                mctx.lineTo(x, h);
                mctx.stroke();
            }

            // Horizontal lines moving
            const speed = 0.6;
            const lines = 30;
            for (let i = 0; i < lines; i++) {
                const p = (i / lines);
                const ease = p * p;
                const y = horizonY + ease * (h - horizonY);
                // Make them move: shift index by time
                const phase = (menuBgT * speed) % 1;
                const yy = horizonY + ((ease + phase) % 1) * (h - horizonY);

                const widthAtY = (yy - horizonY) / (h - horizonY);
                const half = (w * 0.9) * widthAtY;

                mctx.strokeStyle = i % 2 === 0 ? 'rgba(255, 0, 255, 0.22)' : 'rgba(0, 255, 255, 0.18)';
                mctx.beginPath();
                mctx.moveTo(vanishX - half, yy);
                mctx.lineTo(vanishX + half, yy);
                mctx.stroke();
            }
            mctx.globalAlpha = 1;

            // Subtle vignette
            const vig = mctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.1, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
            vig.addColorStop(0, 'rgba(0,0,0,0)');
            vig.addColorStop(1, 'rgba(0,0,0,0.55)');
            mctx.fillStyle = vig;
            mctx.fillRect(0, 0, w, h);

            requestAnimationFrame(drawMenuBg);
        }
        requestAnimationFrame(drawMenuBg);

        window.onload = () => {
            drawCharacterIcon('charStandard', '#ff0000', true, false, false);
            drawCharacterIcon('charTank', '#ff8800', false, false, false);
            drawCharacterIcon('charAmmo', '#40E0D0', false, true, false);
            drawCharacterIcon('charMachete', '#9933FF', false, false, true);
            drawCharacterIcon('charPyro', '#ff7a00', false, false, false);
            drawCharacterIcon('charMesh', '#0b0b0b', false, false, false);
            // Skyler icon: purple with red outline (drawn as circle in drawCharacterIcon)
            drawCharacterIcon('charSkyler', '#a855f7', false, false, false);

            // Secret character is session-only: hide by default on each reload
            const pyroCard = document.getElementById('charPyroCard');
            if (pyroCard) pyroCard.style.display = 'none';

            try {
                const vol = 1;
                menuMusic.volume = vol;
                level1Music.volume = vol;
                if (level2Music) level2Music.volume = vol;
                if (level3Music) level3Music.volume = vol;
                if (level4Music) level4Music.volume = vol;
                if (bossMusic) bossMusic.volume = vol;
                menuMusic.play();
                menuMusicStarted = true;
            } catch (e) {
                console.warn('Автозапуск музыки меню может быть заблокирован браузером:', e);
            }
        };

        function startLevel1Music() {
            try {
                level1Music.currentTime = 0;
                level1Music.play();
            } catch (e) {
                console.warn('Не удалось запустить музыку уровня 1:', e);
            }
        }

        function stopLevel1Music() {
            try {
                level1Music.pause();
                level1Music.currentTime = 0;
            } catch (e) {}
        }

        // ===== HTML MP3 music for levels (2-4) and boss =====
        let currentHtmlMusic = null;

        function stopAllHtmlMusic(resetTime = true) {
            const all = [level1Music, level2Music, level3Music, level4Music, bossMusic];
            for (const a of all) {
                if (!a) continue;
                try {
                    a.pause();
                    if (resetTime) a.currentTime = 0;
                } catch (e) {}
            }
            currentHtmlMusic = null;
        }

        function startHtmlMusicForLevel(level, restart = true) {
            // stops all other level tracks; leaves menuMusic alone
            stopAllHtmlMusic(restart);
            if (!musicEnabled) return;

            let a = null;
            if (level === 1) a = level1Music;
            else if (level === 2) a = level2Music;
            else if (level === 3) a = level3Music;
            else if (level === 4) a = level4Music;
            else if (level === 5) a = bossMusic;

            if (!a) return;
            try {
                if (restart) a.currentTime = 0;
                a.play();
                currentHtmlMusic = a;
            } catch (e) {
                console.warn('Не удалось запустить HTML-музыку уровня:', e);
                currentHtmlMusic = a;
            }
        }

        function pauseHtmlMusic() {
            if (!currentHtmlMusic) return;
            try { currentHtmlMusic.pause(); } catch (e) {}
        }

        function resumeHtmlMusic() {
            if (!musicEnabled || !currentHtmlMusic) return;
            try { currentHtmlMusic.play(); } catch (e) {}
        }

        let settingsOpenedFrom = 'menu';

        function openSettings() {
            settingsOpenedFrom = 'menu';
            document.getElementById('mainMenu').style.display = 'none';
            document.getElementById('settingsMenu').style.display = 'block';
        }

        function openSettingsFromPause() {
            settingsOpenedFrom = 'pause';
            document.getElementById('pauseMenu').style.display = 'none';
            document.getElementById('settingsMenu').style.display = 'block';
        }

        function closeSettings() {
            document.getElementById('settingsMenu').style.display = 'none';
            if (settingsOpenedFrom === 'pause') {
                document.getElementById('pauseMenu').style.display = 'block';
            } else {
                document.getElementById('mainMenu').style.display = 'flex';
            }
        }

        function setLanguage(lang) {
            currentLanguage = lang;
            const texts = {
                ru: {
                    title: 'HOTLINE CIRCLES',
                    start: 'Начать игру',
                    hard: '💀 HARD-MODE 💀',
                    settings: '⚙️ Настройки',
                    settingsTitle: 'НАСТРОЙКИ',
                    languageLabel: 'Язык / Language',
                    resolutionLabel: 'Размер окна',
                    volumeLabel: 'Громкость',
                    settingsBack: 'Назад',

                    levelSelectTitle: 'Выбор уровня',
                    characterSelectTitle: 'Выберите персонажа',
                    back: 'Назад',

                    pauseTitle: 'ПАУЗА',
                    pauseResume: 'Продолжить',
                    pauseRestart: 'Перезапустить уровень',
                    pauseSettings: 'Настройки',
                    pauseExit: 'Выйти в главное меню',

                    deathTitle: '💀 ВЫ ПОГИБЛИ! 💀',
                    deathStats: 'Убито врагов:',
                    deathRestart: '🔄 Перезапустить',
                    deathExit: '🚪 В меню'
                },
                en: {
                    title: 'HOTLINE CIRCLES',
                    start: 'Start Game',
                    hard: '💀 HARD-MODE 💀',
                    settings: '⚙️ Settings',
                    settingsTitle: 'SETTINGS',
                    languageLabel: 'Language',
                    resolutionLabel: 'Window size',
                    volumeLabel: 'Volume',
                    settingsBack: 'Back',

                    levelSelectTitle: 'Level Select',
                    characterSelectTitle: 'Choose character',
                    back: 'Back',

                    pauseTitle: 'PAUSED',
                    pauseResume: 'Resume',
                    pauseRestart: 'Restart level',
                    pauseSettings: 'Settings',
                    pauseExit: 'Exit to main menu',

                    deathTitle: '💀 YOU DIED! 💀',
                    deathStats: 'Enemies killed:',
                    deathRestart: '🔄 Restart',
                    deathExit: '🚪 Main menu'
                }
            }[lang];

            document.getElementById('titleText').textContent = texts.title;
            document.getElementById('startButton').textContent = texts.start;
            document.getElementById('hardModeButton').textContent = texts.hard;
            document.getElementById('settingsButton').textContent = texts.settings;
            document.getElementById('settingsTitle').textContent = texts.settingsTitle;
            document.getElementById('languageLabel').textContent = texts.languageLabel;
            document.getElementById('resolutionLabel').textContent = texts.resolutionLabel;
            document.getElementById('volumeLabel').textContent = texts.volumeLabel;
            document.getElementById('settingsBackButton').textContent = texts.settingsBack;

            const lvlTitle = document.getElementById('levelSelectTitle');
            if (lvlTitle) lvlTitle.textContent = texts.levelSelectTitle;

            // Chapter title translation
            const chapterTitleEl = document.getElementById('chapterTitle');
            if (chapterTitleEl) {
                chapterTitleEl.textContent = (currentChapter === 1)
                    ? (lang === 'ru' ? 'ГЛАВА 1' : 'CHAPTER 1')
                    : (lang === 'ru' ? 'ГЛАВА 2' : 'CHAPTER 2');
            }
            const charTitle = document.getElementById('characterSelectTitle');
            if (charTitle) charTitle.textContent = texts.characterSelectTitle;

            const lvlBackBtn = document.querySelector('#levelSelect .menu-footer .menu-button');
            if (lvlBackBtn) lvlBackBtn.textContent = texts.back;
            const charBackBtn = document.querySelector('#characterSelect .menu-footer .menu-button');
            if (charBackBtn) charBackBtn.textContent = texts.back;

            // Pause / death UI
            const pauseTitleEl = document.getElementById('pauseTitle');
            if (pauseTitleEl) pauseTitleEl.textContent = texts.pauseTitle;
            const pauseResumeEl = document.getElementById('pauseResumeBtn');
            if (pauseResumeEl) pauseResumeEl.textContent = texts.pauseResume;
            const pauseRestartEl = document.getElementById('pauseRestartBtn');
            if (pauseRestartEl) pauseRestartEl.textContent = texts.pauseRestart;
            const pauseSettingsEl = document.getElementById('pauseSettingsBtn');
            if (pauseSettingsEl) pauseSettingsEl.textContent = texts.pauseSettings;
            const pauseExitEl = document.getElementById('pauseMenuExitBtn');
            if (pauseExitEl) pauseExitEl.textContent = texts.pauseExit;

            const deathTitleEl = document.getElementById('deathTitle');
            if (deathTitleEl) deathTitleEl.textContent = texts.deathTitle;
            const deathStatsEl = document.getElementById('deathStats');
            if (deathStatsEl) {
                // keep counts spans
                deathStatsEl.innerHTML = `${texts.deathStats} <span id="deathKills">0</span>/<span id="deathTotal">0</span>`;
            }
            const deathRestartEl = document.getElementById('deathRestartBtn');
            if (deathRestartEl) deathRestartEl.textContent = texts.deathRestart;
            const deathExitEl = document.getElementById('deathMenuBtn');
            if (deathExitEl) deathExitEl.textContent = texts.deathExit;

            // Перевод кнопок уровней (только Глава 1)
            const levelButtons = document.querySelectorAll('#levelGrid .level-button');
            if (lang === 'ru') {
                const ruTexts = [
                    '🎓 Уровень 0 - ОБУЧЕНИЕ',
                    '📍 Уровень 1 - СКЛАД',
                    '🏢 Уровень 2 - ОФИС',
                    '🏭 Уровень 3 - ЗАВОД',
                    '📡 Уровень 4 - ШТАБ',
                    '💀 Уровень 5 - БОСС'
                ];
                levelButtons.forEach((btn, i) => { if (ruTexts[i]) btn.textContent = ruTexts[i]; });
            } else {
                const enTexts = [
                    '🎓 Level 0 - TUTORIAL',
                    '📍 Level 1 - WAREHOUSE',
                    '🏢 Level 2 - OFFICE',
                    '🏭 Level 3 - FACTORY',
                    '📡 Level 4 - HQ',
                    '💀 Level 5 - BOSS'
                ];
                levelButtons.forEach((btn, i) => { if (enTexts[i]) btn.textContent = enTexts[i]; });
            }

            // Перевод карточек персонажей
            const charNames = document.querySelectorAll('#characterSelect .character-name');
            const charDescs = document.querySelectorAll('#characterSelect .character-desc');
            if (lang === 'ru') {
                const names = ['Стандарт', 'Танк', 'Стрелок', 'Рубака'];
                const descs = [
                    'Ускоренная стрельба (ПКМ)\n<b>100 HP</b>',
                    'Щит от урона (ПКМ)\n<b>200 HP</b>',
                    'Аптечка +50 HP (ПКМ)\n    x2 боезапас | <b>100 HP</b>',
                    'Буйство (ПКМ)\nМачете 40 урона | <b>125 HP</b>'
                ];
                charNames.forEach((el, i) => { if (names[i]) el.textContent = names[i]; });
                charDescs.forEach((el, i) => { if (descs[i]) el.innerHTML = descs[i]; });
            } else {
                const names = ['Standard', 'Tank', 'Shooter', 'Butcher'];
                const descs = [
                    'Rapid fire (RMB)\n<b>100 HP</b>',
                    'Damage shield (RMB)\n<b>200 HP</b>',
                    'Medkit +50 HP (RMB)\n    x2 ammo | <b>100 HP</b>',
                    'Rage (RMB)\nMachete 40 dmg | <b>125 HP</b>'
                ];
                charNames.forEach((el, i) => { if (names[i]) el.textContent = names[i]; });
                charDescs.forEach((el, i) => { if (descs[i]) el.innerHTML = descs[i]; });
            }

            // Перевод названия уровня в HUD, если игра уже запущена
            const levelNamesRu = ['ОБУЧЕНИЕ', 'СКЛАД', 'ОФИС', 'ЗАВОД', 'ШТАБ', 'БОСС'];
            const levelNamesEn = ['TUTORIAL', 'WAREHOUSE', 'OFFICE', 'FACTORY', 'HQ', 'BOSS'];
            if (typeof currentLevel !== 'undefined') {
                const index = currentLevel;
                if (levelNamesRu[index] && levelNamesEn[index]) {
                    const title = lang === 'ru'
                        ? `УРОВЕНЬ ${index} - ${levelNamesRu[index]}`
                        : `LEVEL ${index} - ${levelNamesEn[index]}`;
                    const levelNameEl = document.getElementById('levelName');
                    if (levelNameEl) levelNameEl.textContent = title;
                }
            }
        }

        function changeResolution(value) {
            const [w, h] = value.split('x').map(Number);
            canvas.width = w;
            canvas.height = h;
        }

        function changeVolume(value) {
            const vol = parseFloat(value);
            menuMusic.volume = vol;
            level1Music.volume = vol;
            if (level2Music) level2Music.volume = vol;
            if (level3Music) level3Music.volume = vol;
            if (level4Music) level4Music.volume = vol;
            if (bossMusic) bossMusic.volume = vol;
            if (masterGain) masterGain.gain.value = vol;
        }

        function drawCharacterIcon(id, color, hasLine, hasBelt, hasSkull = false) {
            const c = document.getElementById(id);
            if (!c) return;
            const ct = c.getContext('2d'), r = id === 'charTank' ? 45 : 30, cx = 50, cy = 50;
            ct.clearRect(0, 0, c.width, c.height);

            // Pyro special icon: must match in-game look (orange circle + 2 red tanks behind)
            if (id === 'charPyro') {
                const aim = 0; // facing right, so tanks are behind (left)
                const back = aim + Math.PI;

                // Base body
                ct.fillStyle = '#ff7a00';
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.fill();

                // Body glow/gradient (same vibe as in-game)
                const grad = ct.createRadialGradient(cx, cy - 4, 2, cx, cy, r + 12);
                grad.addColorStop(0, 'rgba(255, 240, 170, 0.35)');
                grad.addColorStop(0.25, 'rgba(255, 140, 0, 0.55)');
                grad.addColorStop(1, 'rgba(170, 10, 0, 0.25)');
                ct.save();
                ct.globalCompositeOperation = 'lighter';
                ct.fillStyle = grad;
                ct.beginPath();
                ct.arc(cx, cy, r + 2, 0, Math.PI * 2);
                ct.fill();
                ct.restore();

                // Two tanks behind (same geometry as in-game player)
                const tankOffset = 10;
                const tankDist = r + 10;
                const bx = Math.cos(back) * tankDist;
                const by = Math.sin(back) * tankDist;

                for (const s of [-1, 1]) {
                    const ox = bx + Math.cos(back + Math.PI / 2) * (tankOffset * s);
                    const oy = by + Math.sin(back + Math.PI / 2) * (tankOffset * s);

                    ct.save();
                    ct.translate(cx + ox, cy + oy);
                    ct.rotate(aim);

                    ct.fillStyle = '#b10000';
                    ct.strokeStyle = '#4a0000';
                    ct.lineWidth = 2;
                    ct.beginPath();
                    ct.roundRect(-6, -14, 12, 28, 6);
                    ct.fill();
                    ct.stroke();

                    // highlight
                    ct.globalAlpha = 0.25;
                    ct.fillStyle = '#ff4040';
                    ct.fillRect(-4, -12, 2, 24);
                    ct.globalAlpha = 1;

                    // valve cap
                    ct.fillStyle = '#222';
                    ct.beginPath();
                    ct.arc(0, -16, 4, 0, Math.PI * 2);
                    ct.fill();

                    ct.restore();
                }

                // Outline
                ct.strokeStyle = '#fff';
                ct.lineWidth = 3;
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.stroke();
                return;
            }

            // Skyler icon: purple circle with red outline
            if (id === 'charSkyler') {
                ct.fillStyle = '#a855f7';
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.fill();

                ct.strokeStyle = '#ff3b3b';
                ct.lineWidth = 5;
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.stroke();

                ct.strokeStyle = '#fff';
                ct.lineWidth = 2;
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.stroke();
                return;
            }

            ct.fillStyle = color;
            ct.beginPath();
            ct.arc(cx, cy, r, 0, Math.PI * 2);
            ct.fill();

            if (hasLine) {
                ct.strokeStyle = '#fff';
                ct.lineWidth = 4;
                ct.beginPath();
                ct.moveTo(cx - r + 5, cy - r + 8);
                ct.lineTo(cx + r - 5, cy - r + 8);
                ct.stroke();
            }

            if (hasBelt) {
                ct.save();
                ct.translate(cx, cy);
                ct.rotate(-Math.PI / 4);
                ct.fillStyle = '#8B4513';
                ct.fillRect(-r - 10, -5, r * 2 + 20, 10);
                for (let i = -r; i <= r; i += 15) {
                    ct.fillStyle = '#FFD700';
                    ct.fillRect(i, -8, 6, 8);
                    ct.fillStyle = '#ff0000';
                    ct.beginPath();
                    ct.moveTo(i + 3, -13);
                    ct.lineTo(i, -8);
                    ct.lineTo(i + 6, -8);
                    ct.closePath();
                    ct.fill();
                    ct.fillStyle = '#ffcccc';
                    ct.beginPath();
                    ct.moveTo(i + 3, -13);
                    ct.lineTo(i + 1, -11);
                    ct.lineTo(i + 3, -8);
                    ct.closePath();
                    ct.fill();
                }
                ct.restore();
            }

            if (hasSkull) {
                ct.fillStyle = '#fff';
                ct.beginPath();
                ct.arc(cx, cy - 8, 15, 0, Math.PI * 2);
                ct.fill();
                ct.fillStyle = '#000';
                ct.beginPath();
                ct.arc(cx - 6, cy - 11, 3, 0, Math.PI * 2);
                ct.arc(cx + 6, cy - 11, 3, 0, Math.PI * 2);
                ct.fill();
                ct.beginPath();
                ct.moveTo(cx, cy - 5);
                ct.lineTo(cx - 2, cy - 1);
                ct.lineTo(cx + 2, cy - 1);
                ct.closePath();
                ct.fill();
                ct.beginPath();
                ct.moveTo(cx - 10, cy + 4);
                ct.lineTo(cx + 10, cy + 4);
                ct.arc(cx, cy + 4, 10, 0, Math.PI, true);
                ct.closePath();
                ct.fill();
            }

            if (color === '#ff8800') {
                ct.strokeStyle = '#000';
                ct.lineWidth = 5;
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.stroke();
            }
        }

        // Chapter select state (Level Select)
        let currentChapter = 1;

        function renderChapterSelect() {
            const titleEl = document.getElementById('chapterTitle');
            const grid1 = document.getElementById('levelGrid');
            const grid2 = document.getElementById('levelGrid2');
            const prevBtn = document.getElementById('chapterPrev');
            const nextBtn = document.getElementById('chapterNext');

            const isRu = (currentLanguage === 'ru');
            const title = (currentChapter === 1)
                ? (isRu ? 'ГЛАВА 1' : 'CHAPTER 1')
                : (isRu ? 'ГЛАВА 2' : 'CHAPTER 2');

            if (titleEl) titleEl.textContent = title;
            if (grid1) grid1.style.display = (currentChapter === 1) ? 'grid' : 'none';
            if (grid2) grid2.style.display = (currentChapter === 2) ? 'grid' : 'none';

            // Only 2 chapters right now
            if (prevBtn) prevBtn.disabled = (currentChapter <= 1);
            if (nextBtn) nextBtn.disabled = (currentChapter >= 2);
        }

        function switchChapter(dir) {
            currentChapter = Math.max(1, Math.min(2, currentChapter + dir));
            renderChapterSelect();
        }

        function showLevelSelect() {
            document.getElementById('mainMenu').style.display = 'none';
            document.getElementById('levelSelect').style.display = 'block';
            // Always open on Chapter 1
            currentChapter = 1;
            renderChapterSelect();
        }

        // Chapter 2: select a story level (fixed character per level)
        function selectChapter2Level(level) {
            chapter2Active = true;
            chapter2Level = level;
            document.getElementById('levelSelect').style.display = 'none';

            // Level 1: HoTRoD (Jack)
            if (level === 1) {
                document.getElementById('characterSelectCh2').style.display = 'block';
                return;
            }

            // Level 2: Skyward Ascent (Skyler)
            if (level === 2) {
                document.getElementById('characterSelectCh2L2').style.display = 'block';
                return;
            }

            // Fallback
            document.getElementById('levelSelect').style.display = 'block';
        }

        function selectCharacterCh2(character, el) {
            selectedCharacter = character;
            document.querySelectorAll('#characterSelectCh2 .character-card').forEach(card => card.classList.remove('selected'));
            if (el) el.classList.add('selected');
            // For HoTRoD we play a short intro cutscene right after character selection
            hotrodIntroPending = true;
            setTimeout(() => {
                document.getElementById('characterSelectCh2').style.display = 'none';
                startGame(100 + chapter2Level); // use 100+N as internal ID for chapter 2
            }, 300);
        }

        function backToLevelSelectFromCh2() {
            document.getElementById('characterSelectCh2').style.display = 'none';
            document.getElementById('levelSelect').style.display = 'block';
            chapter2Active = false;
            chapter2Level = 0;
        }

        function selectCharacterCh2L2(character, el) {
            selectedCharacter = character;
            document.querySelectorAll('#characterSelectCh2L2 .character-card').forEach(card => card.classList.remove('selected'));
            if (el) el.classList.add('selected');
            setTimeout(() => {
                document.getElementById('characterSelectCh2L2').style.display = 'none';
                startGame(100 + chapter2Level);
            }, 300);
        }

        function backToLevelSelectFromCh2L2() {
            document.getElementById('characterSelectCh2L2').style.display = 'none';
            document.getElementById('levelSelect').style.display = 'block';
            chapter2Active = false;
            chapter2Level = 0;
        }

        function selectLevelForCharacterChoice(level) { selectedLevel = level; document.getElementById('levelSelect').style.display = 'none'; document.getElementById('characterSelect').style.display = 'block'; }
        function backToLevelSelect() { document.getElementById('characterSelect').style.display = 'none'; document.getElementById('levelSelect').style.display = 'block'; }
        function selectCharacter(character, el) {
            selectedCharacter = character;
            document.querySelectorAll('.character-card').forEach(card => card.classList.remove('selected'));
            if (el) el.classList.add('selected');
            setTimeout(() => startGame(selectedLevel), 300);
        }
        function backToMainMenu() {
            document.getElementById('levelSelect').style.display = 'none';
            document.getElementById('mainMenu').style.display = 'flex';
            // reset chapter view for next open
            currentChapter = 1;
            renderChapterSelect();
        }

        function startHardMode() {
            hardMode = true;
            hardModeProgress = 1;
            medkitUsed = false;
            selectedLevel = 1;
            document.getElementById('mainMenu').style.display = 'none';
            document.getElementById('characterSelect').style.display = 'block';
        }

        function checkSecretCode() {
            showGamePrompt('Введите код:', 'Секретный код').then(code => {
                if (code === '8267') {
                    const card = document.getElementById('charPyroCard');
                    if (card) card.style.display = 'block';
                    showGameAlert('Все верно! Персонаж «Поджигатель» открыт.', 'Секретный код');
                    console.log('Секретный код принят! Поджигатель открыт');
                } else if (code !== null && code !== undefined) {
                    showGameAlert('Подумай ещё...', 'Секретный код');
                }
            }).catch(() => {});
        }

        document.addEventListener('keydown', (e) => {
            keys[e.key.toLowerCase()] = true;
            if (e.key === 'ц' || e.key === 'Ц') keys['w'] = true;
            if (e.key === 'ф' || e.key === 'Ф') keys['a'] = true;
            if (e.key === 'ы' || e.key === 'Ы') keys['s'] = true;
            if (e.key === 'в' || e.key === 'В') keys['d'] = true;

            // Skip HoTRoD cutscene
            if ((e.key.toLowerCase() === 'e' || e.key === 'у' || e.key === 'У') && hotrodCutscene.active) {
                e.preventDefault();
                skipHotrodCutscene();
                return;
            }

            if (e.key === 'Escape' && gameState === 'playing') pauseGame();
            else if (e.key === 'Escape' && gameState === 'paused') resumeGame();

            if (e.key.toLowerCase() === 'e' || e.key === 'у' || e.key === 'У') pickupWeapon();
            if (e.key === ' ') { e.preventDefault(); switchToPistol(); }
        });
        document.addEventListener('keyup', (e) => {
            keys[e.key.toLowerCase()] = false;
            if (e.key === 'ц' || e.key === 'Ц') keys['w'] = false;
            if (e.key === 'ф' || e.key === 'Ф') keys['a'] = false;
            if (e.key === 'ы' || e.key === 'Ы') keys['s'] = false;
            if (e.key === 'в' || e.key === 'В') keys['d'] = false;
        });
        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            mouse.x = e.clientX - rect.left; mouse.y = e.clientY - rect.top;
            mouse.worldX = mouse.x + camera.x; mouse.worldY = mouse.y + camera.y;
        });
        canvas.addEventListener('mousedown', () => mouse.clicked = true);
        canvas.addEventListener('mouseup', () => mouse.clicked = false);
        canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); useAbility(); });

        function useAbility() {
            if (!abilityAvailable || gameState !== 'playing') return;

            if (selectedCharacter === 'standard') {
                if (player.weapon === player.startingWeapon) return;
                abilityAvailable = false; abilityActive = true; abilityTimer = 180;
                originalFireRate = weapons[player.weapon].fireRate;
                currentWeapon.fireRate = Math.floor(originalFireRate / 3);
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Активна!';
                document.getElementById('abilityText').style.color = '#00ff00';
            } else if (selectedCharacter === 'tank') {
                abilityAvailable = false; abilityActive = true; abilityTimer = 180;
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Щит активен!';
                document.getElementById('abilityText').style.color = '#00ffff';
            } else if (selectedCharacter === 'ammo') {
                if (medkitUsed || player.hp >= player.maxHP) return;
                medkitUsed = true;
                abilityAvailable = false;
                player.hp = Math.min(player.maxHP, player.hp + 50);
                updateHUD();
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Использована!';
                document.getElementById('abilityText').style.color = '#ff0000';
            } else if (selectedCharacter === 'machete_char') {
                abilityAvailable = false; abilityActive = true; abilityTimer = 600;
                weapons.machete.range = 150;
                currentWeapon.range = 150;
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'БУЙСТВО!';
                document.getElementById('abilityText').style.color = '#ff0000';
            } else if (selectedCharacter === 'pyro') {
                // Fire aura: damages enemies in a circle and regenerates flamethrower fuel while active
                abilityAvailable = false; abilityActive = true; abilityTimer = 600; // 10 seconds
                pyroAura.active = true;
                pyroAura.t = 0;
                pyroAura.tickAcc = 0;

                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Огненный круг!';
                document.getElementById('abilityText').style.color = '#ff7a00';
            } else if (selectedCharacter === 'mesh') {
                // Jack grenade ability - consumes grenade ammo
                if (meshGrenadeCount <= 0) {
                    document.getElementById('abilityStatus').style.display = 'block';
                    document.getElementById('abilityText').textContent = 'Нет гранат!';
                    document.getElementById('abilityText').style.color = '#ff0000';
                    setTimeout(() => {
                        if (selectedCharacter === 'mesh') {
                            document.getElementById('abilityText').textContent = `Готова (ПКМ) x${meshGrenadeCount}`;
                            document.getElementById('abilityText').style.color = '#00ff00';
                        }
                    }, 800);
                    return;
                }

                if (meshGrenades.length >= 3) return; // max 3 grenades at once

                meshGrenadeCount--;

                const angle = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x);
                const throwSpeed = 8;
                meshGrenades.push({
                    x: player.x,
                    y: player.y,
                    vx: Math.cos(angle) * throwSpeed,
                    vy: Math.sin(angle) * throwSpeed,
                    radius: 8,
                    timer: 180, // 3 seconds at 60fps
                    explosionRadius: 170,
                    damage: 100
                });

                // No cooldown lock; you can throw again as long as you have grenades.
                abilityAvailable = true;

                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = `Граната! (-1) осталось: ${meshGrenadeCount}`;
                document.getElementById('abilityText').style.color = '#ff4444';

                setTimeout(() => {
                    if (selectedCharacter === 'mesh') {
                        document.getElementById('abilityText').textContent = `Готова (ПКМ) x${meshGrenadeCount}`;
                        document.getElementById('abilityText').style.color = '#00ff00';
                    }
                }, 650);
            } else if (selectedCharacter === 'skyler') {
                // Skyler dash: short dash with 3s cooldown + отдельный таймер неуязвимости
                if (skylerDash.cooldown > 0 || skylerDash.active) return;

                // On Skyward Ascent: require aiming into some walkable zone (so you can "jump" gaps to another roof)
                if (currentLevel === 102) {
                    let ok = false;
                    for (const z of skywardWalkZones) {
                        if (mouse.worldX >= z.x && mouse.worldX <= z.x + z.w && mouse.worldY >= z.y && mouse.worldY <= z.y + z.h) { ok = true; break; }
                    }
                    if (!ok) return;
                }

                const a = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x);
                const dashSpeed = 24; // a bit longer for crossing gaps
                skylerDash.active = true;
                skylerDash.t = skylerDash.duration;
                skylerDash.vx = Math.cos(a) * dashSpeed;
                skylerDash.vy = Math.sin(a) * dashSpeed;
                skylerDash.cooldown = skylerDash.cooldownMax;
                // 2 секунды неуязвимости (120 кадров при 60 FPS)
                skylerDash.invulnT = 120;

                // HUD text
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'РЫВОК!';
                document.getElementById('abilityText').style.color = '#ff3b3b';
                setTimeout(() => {
                    if (selectedCharacter === 'skyler') {
                        document.getElementById('abilityText').textContent = (skylerDash.cooldown > 0) ? 'Перезарядка...' : 'Готова (ПКМ)';
                        document.getElementById('abilityText').style.color = (skylerDash.cooldown > 0) ? '#ff4444' : '#00ff00';
                    }
                }, 450);
            }
        }

        function updateAbility() {
            if (abilityActive) {
                abilityTimer--;
                if (abilityTimer <= 0) {
                    abilityActive = false;
                    if (selectedCharacter === 'standard') currentWeapon.fireRate = weapons[player.weapon].fireRate;
                    else if (selectedCharacter === 'machete_char') { weapons.machete.range = originalMacheteRange; currentWeapon.range = originalMacheteRange; }
                    else if (selectedCharacter === 'pyro') { pyroAura.active = false; }
                    document.getElementById('abilityText').textContent = 'Использована';
                    document.getElementById('abilityText').style.color = '#ff0000';
                }
            }
        }

        function initAudio() {
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                masterGain = audioContext.createGain();
                masterGain.gain.value = parseFloat(document.getElementById('volumeSlider').value || '1');
                masterGain.connect(audioContext.destination);
            }
        }

        function playLevelMusic(level) {
            if (!musicEnabled || !audioContext) return;
            stopMusic();
            if (level === 1) { return; }
            if (level === 5) { playBossMusic(); return; }
            const configs = [
                { bpm: 90, pattern: (b) => { if (b % 2 === 0) playKick(); if (b % 8 === 4) playSnare(); playHihat(); playBass(100); if (b % 4 === 0) playSynth([220, 262, 330, 262][b/4 % 4], 0.4, 'sine'); } },
                { bpm: 100, pattern: (b) => { const s = b % 16; if (s % 4 === 0) playKick(); if (s === 4 || s === 12) playSnare(); if (s % 2 === 0) { playHihat(); playBass(110); } if (s % 4 === 0) playSynth([440, 494, 523, 494, 440, 392, 349, 392][s / 4 % 8], 0.3, 'square'); } },
                { bpm: 128, pattern: (b) => { const s = b % 32, sec = Math.floor(b / 32) % 2; if (s % 2 === 0) playKick(); if (s === 4 || s === 12 || s === 20 || s === 28) playSnare(); playHihat(); if (s % 2 === 0) { playBass([[98, 98, 110, 98, 110, 123, 110, 98], [82, 82, 98, 82, 110, 98, 82, 73]][sec][Math.floor(s / 2) % 8]); playSynth([[392, 440, 494, 523, 494, 440, 392, 349], [523, 587, 659, 698, 659, 587, 523, 494]][sec][Math.floor(s / 2) % 8], 0.15, 'sawtooth'); } } },
                { bpm: 145, pattern: (b) => { const s = b % 64; playKick(); if (s % 8 === 4) playSnare(); playHihat(); playBass([65, 69, 73, 69, 65, 58, 55, 58][s % 8]); playSynth([330, 349, 392, 440, 392, 349, 330, 294][s % 8], 0.12, 'triangle'); if (s % 16 === 0) playDistortedHit(); } },
                { bpm: 165, pattern: (b) => { const s = b % 64; playKick(); if (s % 4 === 2) playSnare(); playHihat(); playBass([55, 58, 62, 65, 69, 73, 77, 82][s % 8]); playSynth([523, 587, 659, 740, 784, 880, 988, 1047][s % 8], 0.18, 'sawtooth'); if (s % 8 === 0) playDistortedHit(); } }
            ];
            if (configs[level]) {
                let beat = 0;
                const interval = setInterval(() => { configs[level].pattern(beat); beat++; }, (60 / configs[level].bpm) * 250);
                musicIntervals.push(interval);
            }
        }

        function playKick() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.frequency.setValueAtTime(150, audioContext.currentTime); o.frequency.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5); g.gain.setValueAtTime(1, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.5); }
        function playBass(note) { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(note, audioContext.currentTime); g.gain.setValueAtTime(0.3, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.3); }
        function playHihat() { const bufferSize = audioContext.sampleRate * 0.1, buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate), output = buffer.getChannelData(0); for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1; const noise = audioContext.createBufferSource(); noise.buffer = buffer; const filter = audioContext.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 8000; const gain = audioContext.createGain(); gain.gain.setValueAtTime(0.15, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1); noise.connect(filter); filter.connect(gain); gain.connect(masterGain); noise.start(audioContext.currentTime); }
        function playSnare() { const o = audioContext.createOscillator(), noise = audioContext.createBufferSource(), bufferSize = audioContext.sampleRate * 0.2, buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate), output = buffer.getChannelData(0); for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1; noise.buffer = buffer; const oscGain = audioContext.createGain(), noiseGain = audioContext.createGain(); o.frequency.setValueAtTime(200, audioContext.currentTime); oscGain.gain.setValueAtTime(0.5, audioContext.currentTime); oscGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2); noiseGain.gain.setValueAtTime(0.5, audioContext.currentTime); noiseGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2); o.connect(oscGain); noise.connect(noiseGain); oscGain.connect(masterGain); noiseGain.connect(masterGain); o.start(audioContext.currentTime); noise.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.2); }
        function playSynth(freq, duration = 0.2, type = 'sine') { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = type; o.frequency.setValueAtTime(freq, audioContext.currentTime); g.gain.setValueAtTime(0.1, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + duration); }
        function playDistortedHit() { const o = audioContext.createOscillator(), g = audioContext.createGain(), d = audioContext.createWaveShaper(), curve = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = (i * 2) / 256 - 1; curve[i] = Math.tanh(3 * x); } d.curve = curve; o.frequency.setValueAtTime(100, audioContext.currentTime); g.gain.setValueAtTime(0.3, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1); o.connect(d); d.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.1); }

        function playBossMusic() {
            let beat = 0;
            const interval = setInterval(() => {
                const s = beat % 16;
                if (s % 2 === 0) playHeavyKick();
                if (s % 1 === 0) playAggressiveBass();
                if (s % 2 === 0) playChaoticLead();
                if (s % 3 === 0) playHeavyNoise();
                beat++;
            }, (60 / 180) * 250);
            musicIntervals.push(interval);
        }

        function playHeavyKick() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.frequency.setValueAtTime(60, audioContext.currentTime); o.frequency.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3); g.gain.setValueAtTime(1.5, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.3); }
        function playAggressiveBass() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime([55, 58, 62, 65][Math.floor(Math.random() * 4)], audioContext.currentTime); g.gain.setValueAtTime(0.4, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.2); }
        function playChaoticLead() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = 'square'; o.frequency.setValueAtTime([220, 233, 247, 262][Math.floor(Math.random() * 4)], audioContext.currentTime); g.gain.setValueAtTime(0.15, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.15); }
        function playHeavyNoise() { const bufferSize = audioContext.sampleRate * 0.05, buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate), output = buffer.getChannelData(0); for (let i = 0; i < bufferSize; i++) output[i] = (Math.random() - 0.5) * 2; const noise = audioContext.createBufferSource(); noise.buffer = buffer; const g = audioContext.createGain(); g.gain.setValueAtTime(0.2, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.05); noise.connect(g); g.connect(masterGain); noise.start(audioContext.currentTime); }

        function playCowboyMusic() {
            let beat = 0;
            const interval = setInterval(() => {
                const s = beat % 32;
                if (s % 2 === 0) playKick(); if (s % 4 === 2) playSnare(); playHihat();
                if (s % 4 === 0) playBass([82, 87, 98, 110][s / 4 % 4]);
                if (s % 1 === 0) playSynth([330, 349, 392, 440, 494, 523, 587, 659][s % 8], 0.1, 'square');
                if (s % 2 === 0) playSynth([330, 349, 392, 440, 494, 523, 587, 659][(s + 4) % 8] * 1.5, 0.15, 'sawtooth');
                if (s % 8 === 0) playDistortedHit(); if (s % 3 === 0) playHeavyNoise();
                beat++;
            }, (60 / 200) * 250);
            musicIntervals.push(interval);
        }

        function stopMusic() { musicIntervals.forEach(interval => clearInterval(interval)); musicIntervals = []; }
        function toggleMusic() {
            musicEnabled = !musicEnabled;

            if (!musicEnabled) {
                // Stop synth music (legacy) + pause current HTML track
                stopMusic();
                try { menuMusic.pause(); } catch (e) {}
                pauseHtmlMusic();
                return;
            }

            // Enable
            if (gameState === 'menu') {
                try { menuMusic.play(); } catch (e) {}
                return;
            }

            // Don't start music while paused; resume when unpaused
            if (gameState !== 'playing') return;

            // Resume current track if present; otherwise start correct level track
            if (currentHtmlMusic) {
                resumeHtmlMusic();
            } else {
                startHtmlMusicForLevel(currentLevel, false);
            }
        }

        function playSound(type) {
            if (!audioContext) return;

            // Special: continuous-ish flame "whoosh" kept short to avoid audio spam
            if (type === 'flame') {
                const t = audioContext.currentTime;
                const noiseBufferSize = Math.floor(audioContext.sampleRate * 0.08);
                const buffer = audioContext.createBuffer(1, noiseBufferSize, audioContext.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < noiseBufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / noiseBufferSize);
                const noise = audioContext.createBufferSource();
                noise.buffer = buffer;

                const filter = audioContext.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.setValueAtTime(900, t);
                filter.Q.setValueAtTime(0.7, t);

                const g = audioContext.createGain();
                g.gain.setValueAtTime(0.10, t);
                g.gain.exponentialRampToValueAtTime(0.01, t + 0.08);

                noise.connect(filter);
                filter.connect(g);
                g.connect(masterGain);
                noise.start(t);
                noise.stop(t + 0.08);
                return;
            }

            const o = audioContext.createOscillator(), g = audioContext.createGain();
            o.connect(g); g.connect(masterGain);
            const sounds = { pew: [400, 'square', 0.1], boom: [100, 'sawtooth', 0.15], tak: [800, 'sine', 0.08], brr: [600, 'triangle', 0.06], snipe: [1200, 'sine', 0.2], slice: [600, 'sawtooth', 0.2], hit_target: [2000, 'square', 0.1] };
            if (sounds[type]) { o.frequency.value = sounds[type][0]; o.type = sounds[type][1]; g.gain.value = sounds[type][2]; }
            o.start(); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1); o.stop(audioContext.currentTime + 0.1);
        }

        function restartLevel() {
            document.getElementById('deathMenu').style.display = 'none';
            document.getElementById('pauseMenu').style.display = 'none';
            abilityAvailable = true;
            abilityActive = false;
            abilityTimer = 0;
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;

            stopMusic();
            stopAllHtmlMusic(true);

            if (hardMode) {
                hardModeProgress = 1;
                medkitUsed = false;
                document.getElementById('gameContainer').style.display = 'none';
                document.getElementById('characterSelect').style.display = 'block';
                selectedLevel = 1;
            } else {
                initLevel(currentLevel);
                gameState = 'playing';
                if (musicEnabled) {
                    startHtmlMusicForLevel(currentLevel, true);
                }
            }
        }
        function exitToMenu() { document.getElementById('deathMenu').style.display = 'none'; document.getElementById('pauseMenu').style.display = 'none'; backToMainMenuFromGame(); }
        function pauseGame() {
            if (gameState === 'playing') {
                gameState = 'paused';
                stopMusic();
                pauseHtmlMusic();
                document.getElementById('pauseMenu').style.display = 'block';
            }
        }
        function resumeGame() {
            if (gameState === 'paused') {
                gameState = 'playing';
                document.getElementById('pauseMenu').style.display = 'none';
                if (musicEnabled) {
                    resumeHtmlMusic();
                }
            }
        }

        function startGame(level) {
            initAudio();
            if (!menuMusicStarted) {
                try {
                    menuMusic.play();
                    menuMusicStarted = true;
                } catch (e) {}
            }
            menuMusic.pause();
            menuMusic.currentTime = 0;
            stopMusic();
            stopAllHtmlMusic(true);

            // Keep HARD-MODE progress in sync with the level being played
            if (hardMode) {
                hardModeProgress = level;
            }

            currentLevel = level; gameState = 'playing';
            // Safety: ensure pyro aura never carries over into a new game start
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;

            document.getElementById('characterSelect').style.display = 'none';
            document.getElementById('gameContainer').style.display = 'block';

            // Level title (supports Chapter 2 internal IDs: 101, 102, ...)
            if (level >= 101) {
                const chapter2Names = {
                    101: 'HoTRoD',
                    102: 'Skyward Ascent'
                };
                const name = chapter2Names[level] || `CH2-${level - 100}`;
                document.getElementById('levelName').textContent = `ГЛАВА 2 - ${name}`;
            } else {
                const levelNames = ['ОБУЧЕНИЕ', 'СКЛАД', 'ОФИС', 'ЗАВОД', 'ШТАБ', 'БОСС'];
                document.getElementById('levelName').textContent = `УРОВЕНЬ ${level} - ${levelNames[level]}`;
            }

            document.getElementById('bossHealth').style.display = level === 5 ? 'block' : 'none';

            const abilityTexts = {
                standard: 'Готова (ПКМ)',
                tank: 'Готова (ПКМ)',
                ammo: 'Готова (ПКМ)',
                machete_char: 'Готова (ПКМ)',
                pyro: 'Готова (ПКМ)',
                mesh: 'Готова (ПКМ)',
                skyler: 'Готова (ПКМ)'
            };

            if (abilityTexts[selectedCharacter]) {
                document.getElementById('abilityStatus').style.display = 'block';
                // For MESH show grenade amount
                if (selectedCharacter === 'mesh') {
                    document.getElementById('abilityText').textContent = `Готова (ПКМ) x${meshGrenadeCount}`;
                } else {
                    document.getElementById('abilityText').textContent = abilityTexts[selectedCharacter];
                }
                document.getElementById('abilityText').style.color = '#00ff00';
            } else {
                document.getElementById('abilityStatus').style.display = 'none';
            }

            initLevel(level);


            if (musicEnabled) {
                // Use MP3 tracks for levels 1-5: 2.mp3..6.mp3
                if (level <= 5) startHtmlMusicForLevel(level, true);
                // Chapter 2 can reuse any track later; for now keep it silent or you can choose a track.
            }
        }

        function switchToPistol() {
            equipWeapon(player.startingWeapon);
        }

        let ambientParticles = [];

        function initLevel(level) {
            player.x = level === 0 ? WORLD_WIDTH / 2 : 150; player.y = level === 0 ? WORLD_HEIGHT / 2 : 150;
            abilityAvailable = true; abilityActive = false; abilityTimer = 0;
            player.lastHpThreshold = 100;
            medkitUsed = false;
            document.getElementById('miniBossHealth').style.display = 'none';
            for (const type in weapons) if (weapons[type].originalAmmo !== undefined) { weapons[type].ammo = weapons[type].originalAmmo; delete weapons[type].originalAmmo; }

            applyLevelTheme(level);

            const charConfigs = {
                standard: { hp: 100, maxHP: 100, color: '#ff0000', hasTopLine: true, radius: 15, startingWeapon: 'pistol' },
                tank: { hp: 200, maxHP: 200, color: '#ff8800', hasTopLine: false, radius: 22, startingWeapon: 'pistol' },
                ammo: { hp: 100, maxHP: 100, color: '#40E0D0', hasTopLine: false, radius: 15, startingWeapon: 'pistol' },
                machete_char: { hp: 125, maxHP: 125, color: '#9933FF', hasTopLine: false, radius: 15, startingWeapon: 'machete' },
                pyro: { hp: 100, maxHP: 100, color: '#ff7a00', hasTopLine: false, radius: 15, startingWeapon: 'flamethrower' },

                // Chapter 2 character: Jack (HoTRoD)
                mesh: { hp: 125, maxHP: 125, color: '#0b0b0b', hasTopLine: false, radius: 15, startingWeapon: 'mesh_dual', abilityType: 'grenade' },

                // Chapter 2 character: Skyler (Skyward Ascent)
                skyler: { hp: 100, maxHP: 100, color: '#a855f7', hasTopLine: false, radius: 15, startingWeapon: 'skyler_burst', abilityType: 'dash' }
            };
            Object.assign(player, charConfigs[selectedCharacter]);
            if (selectedCharacter === 'ammo') for (const type in weapons) if (weapons[type].ammo !== Infinity) { weapons[type].originalAmmo = weapons[type].ammo; weapons[type].ammo *= 2; }

            // Reset per-run weapon state
            // Important: clear current weapon references so we don't carry ammo from previous level
            player.weapon = null;
            currentWeapon = null;
            playerWeaponsState = {};
            // Ensure starting weapon exists in state (with current "weapons" params, incl. ammo x2 for shooter)
            ensureWeaponState(player.startingWeapon);
            equipWeapon(player.startingWeapon);

            enemies = []; bullets = []; enemyBullets = []; weaponPickups = []; walls = []; obstacles = []; boss = null; miniBoss = null; mainEnemiesDefeated = false; kills = 0; weaponSpawnTimer = 0; macheteSlash = null;
            flameParticles = [];
            flameHeat = [];
            flameFuelPickups = [];
            flameFuelSpawnedThisZero = false;
            meshGrenades = [];
            grenadePickups = [];
            meshGrenadeCount = 0;
            grenadeSpawnTimer = 0;
            explosiveBarrels = [];
            hotrodFinalWaveSpawned = false;

            // Pyro ability must never carry over between levels
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;
            pyroTutorialStartAmmo = null;

            tutorialStage = 0; tutorialTargets = []; tutorialTextElement.style.display = 'none';

            // ===== Chapter 2: HoTRoD (internal level 101) =====
            if (level === 101) {
                // Spawn in start zone (clear)
                player.x = 260;
                player.y = 240;

                createHotrodRoom();
                createHotrodObstacles();
                initAmbient(4);

                // Give some starting grenade ammo (and still allow pickups)
                meshGrenadeCount = 2;
                if (selectedCharacter === 'mesh') {
                    document.getElementById('abilityStatus').style.display = 'block';
                    document.getElementById('abilityText').textContent = `Готова (ПКМ) x${meshGrenadeCount}`;
                    document.getElementById('abilityText').style.color = '#00ff00';
                }

                // Explosive barrels in the room
                spawnExplosiveBarrelsHotrod(7);

                // First wave: 20 enemies. Final wave: 5 miniganer.
                createEnemiesHotrod();

                // Only shotgun + smg pickups + some grenade pickups
                createWeaponPickupsHotrod();

                updateHUD();

                // Start HoTRoD intro cutscene after character selection
                if (hotrodIntroPending) {
                    hotrodIntroPending = false;
                    startHotrodCutscene();
                }

                return;
            }

            // ===== Chapter 2: Skyward Ascent (internal level 102) =====
            if (level === 102) {
                createSkywardLevel();
                initAmbient(102);
                updateHUD();
                return;
            }

            // ===== Chapter 1 original flow =====
            createWalls(level); createObstacles(level);
            createGraffitiForLevel(level);
            initAmbient(level);
            if (level === 0) createTutorialLevel();
            else if (level === 5) createBoss();
            else { createEnemies(level); createWeaponPickups(level); }
            updateHUD();
        }

        function initAmbient(level) {
            ambientParticles = [];
            const amb = levelTheme.ambient;
            if (!amb) return;

            // Keep ambient lightweight to avoid FPS drops
            const count = (level === 2) ? 28 : (level === 4 ? 52 : 44);
            for (let i = 0; i < count; i++) {
                ambientParticles.push({
                    x: Math.random() * WORLD_WIDTH,
                    y: Math.random() * WORLD_HEIGHT,
                    r: 0.6 + Math.random() * (level === 4 ? 2.2 : 1.6),
                    a: Math.random() * Math.PI * 2,
                    s: 0.2 + Math.random() * 0.9,
                    t: Math.random() * 1000
                });
            }
        }

        function updateAmbient() {
            const amb = levelTheme.ambient;
            if (!amb || !ambientParticles.length) return;

            for (const p of ambientParticles) {
                p.t += 1;
                if (amb.type === 'dust') {
                    p.x += 0.15 + p.s * 0.25;
                    p.y += Math.sin((p.t + p.a) * 0.02) * 0.2;
                } else if (amb.type === 'steam') {
                    p.y -= 0.25 + p.s * 0.55;
                    p.x += Math.cos((p.t + p.a) * 0.015) * 0.25;
                } else if (amb.type === 'embers') {
                    p.y -= 0.35 + p.s * 0.85;
                    p.x += Math.sin((p.t + p.a) * 0.03) * 0.35;
                } else if (amb.type === 'flicker') {
                    // stationary dots used as light specks (optimized)
                    if ((p.t & 7) === 0) {
                        p.x += (Math.sin(p.a) * 0.10);
                        p.y += (Math.cos(p.a) * 0.10);
                    }
                } else if (amb.type === 'void') {
                    p.x += Math.sin((p.t + p.a) * 0.012) * 0.18;
                    p.y += Math.cos((p.t + p.a) * 0.012) * 0.18;
                }

                if (p.x < 0) p.x += WORLD_WIDTH;
                if (p.x > WORLD_WIDTH) p.x -= WORLD_WIDTH;
                if (p.y < 0) p.y += WORLD_HEIGHT;
                if (p.y > WORLD_HEIGHT) p.y -= WORLD_HEIGHT;
            }
        }

        function drawAmbient() {
            const amb = levelTheme.ambient;
            if (!amb || !ambientParticles.length) return;

            // Lightweight ambient drawing (avoid expensive blend modes)
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            for (const p of ambientParticles) {
                // Precomputed-ish flicker using a tiny oscillation; keep it subtle
                const tw = 0.65 + 0.35 * Math.sin((p.t + p.a) * 0.02);
                ctx.globalAlpha = 0.12 * tw;
                ctx.fillStyle = tw > 0.72 ? amb.colorA : amb.colorB;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        function applyLevelTheme(level) {
            // Visual-only themes (do not affect gameplay). Kept subtle but distinctive.
            const themes = {
                0: { floorA: '#101018', floorB: '#0a0a12', grid: '#26263a', ambient: null },
                1: { floorA: '#171717', floorB: '#121212', grid: '#303030', ambient: { type: 'dust', colorA: 'rgba(255,210,120,0.10)', colorB: 'rgba(255,255,255,0.06)' } }, // WAREHOUSE
                2: { floorA: '#151724', floorB: '#10121c', grid: '#2a2f4a', ambient: { type: 'flicker', colorA: 'rgba(120,255,220,0.10)', colorB: 'rgba(255,255,255,0.05)' } }, // OFFICE
                3: { floorA: '#141a16', floorB: '#0f1411', grid: '#2b3a31', ambient: { type: 'steam', colorA: 'rgba(180,255,200,0.10)', colorB: 'rgba(255,255,255,0.04)' } }, // FACTORY
                4: { floorA: '#0f1412', floorB: '#0b0f0d', grid: '#26352f', ambient: { type: 'dust', colorA: 'rgba(170,255,210,0.07)', colorB: 'rgba(255,255,255,0.03)' } }, // HQ
                5: { floorA: '#0f0f12', floorB: '#0a0a0d', grid: '#2a2a33', ambient: { type: 'void', colorA: 'rgba(255,0,255,0.08)', colorB: 'rgba(0,255,255,0.08)' } },

                // Chapter 2 Level 2: Skyward Ascent (daytime rooftops)
                102: { floorA: '#bfe9ff', floorB: '#9fd6ff', grid: 'rgba(40,80,120,0.14)', ambient: { type: 'dust', colorA: 'rgba(255,255,255,0.10)', colorB: 'rgba(255,255,255,0.06)' } }
            };
            levelTheme = themes[level] || themes[1];
        }

        function createGraffitiForLevel(level) {
            graffiti = [];
            if (level < 1 || level > 4) return;

            const digitByLevel = { 1: '8', 2: '2', 3: '6', 4: '7' };
            const digit = digitByLevel[level];
            if (!digit) return;

            // Place on floor at a random free position (subtle, not on walls)
            const pos = getRandomFreePosition();
            const x = pos.x;
            const y = pos.y;

            // Small, subtle chalk-like digit
            graffiti.push({
                x,
                y,
                digit,
                rotation: 0,
                size: 54 + Math.floor(Math.random() * 16),
                rough: 0.25 + Math.random() * 0.25
            });
        }

        function drawGraffiti() {
            if (!graffiti || !graffiti.length) return;

            for (const g of graffiti) {
                ctx.save();
                ctx.translate(g.x, g.y);
                ctx.rotate(g.rotation);

                // Slightly uneven chalk stroke using multiple draws (no animation)
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = `700 ${g.size}px Courier New`;

                // soft shadow to blend with floor
                ctx.globalAlpha = 0.20;
                ctx.fillStyle = 'rgba(0,0,0,0.9)';
                ctx.fillText(g.digit, 2, 3);

                // chalk layers
                ctx.globalAlpha = 0.62;
                ctx.fillStyle = 'rgba(245,245,245,0.95)';
                ctx.fillText(g.digit, 0, 0);

                ctx.globalAlpha = 0.22;
                ctx.fillStyle = 'rgba(255,255,255,0.75)';
                // a couple of jittered passes to simulate hand-drawn chalk
                ctx.fillText(g.digit, -1, 1);
                ctx.fillText(g.digit, 1, -1);

                // subtle scuffs
                ctx.globalAlpha = 0.08;
                ctx.strokeStyle = 'rgba(255,255,255,0.7)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(-g.size * 0.45, g.size * 0.22);
                ctx.lineTo(g.size * 0.48, g.size * 0.18);
                ctx.stroke();

                ctx.restore();
            }
        }

        function createObstacles(level) {
            if (level === 0 || level === 5) return;

            // Level-flavored obstacle generation (visual feel + cover layout)
            const preset = {
                1: { // WAREHOUSE
                    count: 26,
                    types: ['box', 'box', 'box', 'barrel', 'barrel', 'table'],
                    palette: { box: '#7a4a22', barrel: '#4b4b4b', table: '#6a3e1e', column: '#5f6b73' }
                },
                2: { // OFFICE (optimized)
                    count: 22,
                    types: ['table', 'table', 'column', 'box'],
                    palette: { box: '#3a3a3a', barrel: '#2f2f2f', table: '#2b3f6b', column: '#6c7a93' }
                },
                3: { // FACTORY
                    count: 34,
                    types: ['column', 'column', 'barrel', 'box', 'table'],
                    palette: { box: '#5d4a2a', barrel: '#5a5a5a', table: '#3b3b3b', column: '#556b5f' }
                },
                4: { // HQ / MILITARY BASE
                    count: 34,
                    types: ['box', 'box', 'box', 'barrel', 'column', 'table'],
                    palette: { box: '#3a4a34', barrel: '#3a3a3a', table: '#2b2f34', column: '#4a5450' }
                }
            }[level] || { count: 20 + level * 7, types: ['box', 'barrel', 'table', 'column'], palette: { box: '#8B4513', barrel: '#696969', table: '#A0522D', column: '#708090' } };

            const count = preset.count + Math.floor(Math.random() * 5);
            for (let i = 0; i < count; i++) {
                let x, y, attempts = 0;
                // Level-specific sizes
                let w = 38 + Math.random() * (level === 2 ? 90 : 70);
                let h = 38 + Math.random() * (level === 2 ? 70 : 70);
                if (level === 2 && Math.random() < 0.18) { w = 110 + Math.random() * 90; h = 22 + Math.random() * 26; } // office partitions (reduced for perf)
                if (level === 3 && Math.random() < 0.25) { w = 28 + Math.random() * 40; h = 140 + Math.random() * 180; } // tall factory columns

                do {
                    x = Math.random() * (WORLD_WIDTH - 400) + 200;
                    y = Math.random() * (WORLD_HEIGHT - 400) + 200;
                    attempts++;
                } while ((checkObstacleOverlap(x, y, w, h) || Math.hypot(x - player.x, y - player.y) < 220) && attempts < 140);

                if (attempts < 140) {
                    const type = preset.types[Math.floor(Math.random() * preset.types.length)];
                    const colors = preset.palette;
                    obstacles.push({ x, y, width: w, height: h, type, color: colors[type] || '#666' });
                    walls.push({ x, y, width: w, height: h });
                }
            }
        }

        function checkObstacleOverlap(x, y, w, h) {
            if (Math.hypot(x - player.x, y - player.y) < 200) return true;
            for (let o of [...obstacles, ...walls]) if (x < o.x + o.width + 50 && x + w > o.x - 50 && y < o.y + o.height + 50 && y + h > o.y - 50) return true;
            return false;
        }

        function createTutorialLevel() {
            player.x = WORLD_WIDTH / 2; player.y = WORLD_HEIGHT / 2;
            const positions = [[700, 300], [1000, 400], [1300, 350], [700, WORLD_HEIGHT - 300], [1000, WORLD_HEIGHT - 400], [1300, WORLD_HEIGHT - 350], [WORLD_WIDTH - 500, WORLD_HEIGHT / 2]];
            positions.forEach(([x, y]) => tutorialTargets.push({ x, y, radius: 25, hp: 100, maxHP: 100, hit: false, color: '#00cc00' }));

            tutorialStage = -1;
            const classInfo = {
                standard: "ВЫ - СТАНДАРТ\n\nСпособность: Ускоренная стрельба (ПКМ)\nНажмите ПКМ с подобранным оружием чтобы стрелять в 3 раза быстрее!\n\nСтиль: Универсальный боец. Подбирайте оружие и используйте способность для максимального урона.\n\nHP: 100\n\n(Нажмите любую клавишу)",
                tank: "ВЫ - ТАНК\n\nСпособность: Щит от урона (ПКМ)\nНажмите ПКМ чтобы активировать щит на 3 секунды - он блокирует весь урон!\n\nСтиль: Агрессивный штурм. Врывайтесь в гущу врагов под защитой щита.\n\nHP: 200 (самый живучий!)\n\n(Нажмите любую клавишу)",
                ammo: "ВЫ - СТРЕЛОК\n\nСпособность: Аптечка (ПКМ)\nНажмите ПКМ чтобы восстановить 50 HP. Работает 1 раз за уровень!\n\nБонус: У вас x2 боезапас для всего оружия.\n\nСтиль: Держите дистанцию, стреляйте точно. Аптечка - на крайний случай.\n\nHP: 100\n\n(Нажмите любую клавишу)",
                machete_char: "ВЫ - РУБАКА\n\nСпособность: Буйство (ПКМ)\nНажмите ПКМ для активации буйства на 10 секунд!\nРадиус удара увеличивается + можете ломать препятствия.\n\nОружие: Мачете (40 урона, ближний бой)\n\nСтиль: Агрессивная резня. Врывайтесь в толпу и рубите всех!\n\nHP: 125\n\n(Нажмите любую клавишу)",
                pyro: "ВЫ - ПОДЖИГАТЕЛЬ\n\nОружие: Огнемет (ЛКМ)\n100 топлива | Средняя дальность\n\nОсобенность: при 0 топлива на карте появится +30 топлива\n\nСпособность: Огненный круг (ПКМ)\n10 секунд: наносит урон врагам в радиусе и\nвосстанавливает топливо +10/сек\n\nHP: 100\n\n(Нажмите любую клавишу)"
            };
            displayTutorialText(classInfo[selectedCharacter]);
        }

        function updateTutorial() {
            const tutorials = {
                standard: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Добро пожаловать!\nИспользуйте WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("Отлично! Стреляйте ЛКМ по мишеням.", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit1 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) { allHit1 = false; for (let i = bullets.length - 1; i >= 0; i--) { const b = bullets[i], dist = Math.hypot(b.x - t.x, b.y - t.y); if (dist < b.radius + t.radius) { t.hp -= b.damage; bullets.splice(i, 1); if (t.hp <= 0) { t.hit = true; t.color = '#cc0000'; playSound('hit_target'); } } } } });
                            if (allHit1) { displayTutorialText("Подберите Дробовик (подойдите и нажмите E).", 3000); createWeaponPickup('shotgun', WORLD_WIDTH - 300, WORLD_HEIGHT / 2); tutorialStage = 2; }
                            break;
                        case 2: if (player.weapon === 'shotgun') { displayTutorialText("Теперь используйте СПОСОБНОСТЬ!\nНажмите ПКМ для ускоренной стрельбы (3x скорость)!,", 4000); tutorialStage = 3; } break;
                        case 3: if (abilityActive) { displayTutorialText("Отлично! Стреляйте быстрее пока способность активна!", 3000); enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 200, 'melee', 0, true)); totalEnemies++; tutorialStage = 4; } break;
                        case 4: if (enemies.length === 0) { displayTutorialText("Обучение пройдено! Используйте способность с любым подобранным оружием.", 5000); setTimeout(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                tank: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Танк готов! Используйте WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("Хорошо! Стреляйте ЛКМ по мишеням.", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit2 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) { allHit2 = false; for (let i = bullets.length - 1; i >= 0; i--) { const b = bullets[i], dist = Math.hypot(b.x - t.x, b.y - t.y); if (dist < b.radius + t.radius) { t.hp -= b.damage; bullets.splice(i, 1); if (t.hp <= 0) { t.hit = true; t.color = '#cc0000'; playSound('hit_target'); } } } } });
                            if (allHit2) { displayTutorialText("Сейчас появится враг.\nИСПОЛЬЗУЙТЕ ЩИТ (ПКМ) перед боем!", 4000); setTimeout(() => { enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 200, 'ranged', 0, true)); totalEnemies++; }, 4000); tutorialStage = 2; }
                            break;
                        case 2: if (abilityActive) { displayTutorialText("Щит активен! Вы неуязвимы 3 секунды!\nАтакуйте врага!", 3000); tutorialStage = 3; } break;
                        case 3: if (enemies.length === 0) { displayTutorialText("Отлично! Ваш большой запас HP (200) и щит - ваше преимущество!", 5000); setTimeout(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                ammo: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Стрелок готов! WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("Стреляйте ЛКМ. У вас x2 боезапас!", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit3 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) { allHit3 = false; for (let i = bullets.length - 1; i >= 0; i--) { const b = bullets[i], dist = Math.hypot(b.x - t.x, b.y - t.y); if (dist < b.radius + t.radius) { t.hp -= b.damage; bullets.splice(i, 1); if (t.hp <= 0) { t.hit = true; t.color = '#cc0000'; playSound('hit_target'); } } } } });
                            if (allHit3) { displayTutorialText("Сейчас враг атакует вас.\nПОЛУЧИТЕ УРОН намеренно!", 3000); enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 200, 'ranged', 0, true)); totalEnemies++; tutorialStage = 2; }
                            break;
                        case 2: if (player.hp < player.maxHP - 30) { displayTutorialText("Теперь ВОССТАНОВИТЕ ЗДОРОВЬЕ!\nНажмите ПКМ для аптечки (+50 HP).", 5000); tutorialStage = 3; } break;
                        case 3: if (medkitUsed) { displayTutorialText("Аптечка использована! 1 раз за уровень.\nПобедите врага!", 3000); tutorialStage = 4; } break;
                        case 4: if (enemies.length === 0) { displayTutorialText("Отлично! x2 боезапас и аптечка - используйте мудро!", 5000); setTimeout(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                machete_char: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Рубака готов! WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("У вас МАЧЕТЕ! Атакуйте ЛКМ вблизи мишеней.", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit4 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) { allHit4 = false; for (let i = bullets.length - 1; i >= 0; i--) { const b = bullets[i], dist = Math.hypot(b.x - t.x, b.y - t.y); if (dist < b.radius + t.radius) { t.hp -= b.damage; bullets.splice(i, 1); if (t.hp <= 0) { t.hit = true; t.color = '#cc0000'; playSound('hit_target'); } } } } });
                            if (allHit4) { displayTutorialText("Сейчас появятся враги.\nИСПОЛЬЗУЙТЕ БУЙСТВО (ПКМ)!", 3000); enemies.push(createEnemy(WORLD_WIDTH - 300, WORLD_HEIGHT - 200, 'melee', 0, true)); enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 300, 'melee', 0, true)); totalEnemies += 2; tutorialStage = 2; }
                            break;
                        case 2: if (abilityActive) { displayTutorialText("БУЙСТВО! Радиус удара x2!\nМожете ломать препятствия!\nРубите всех!", 4000); tutorialStage = 3; } break;
                        case 3: if (enemies.length === 0) { displayTutorialText("Кровавая работа! Буйство длится 10 секунд.\nИспользуйте для максимального урона!", 5000); setTimeout(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                pyro: () => {
                    switch (tutorialStage) {
                        case -1:
                            if (Object.values(keys).some(k => k)) {
                                displayTutorialText("Поджигатель готов! Используйте WASD для перемещения.");
                                tutorialStage = 0;
                            }
                            break;
                        case 0:
                            if (keys['w'] || keys['a'] || keys['s'] || keys['d']) {
                                displayTutorialText("Зажмите ЛКМ и сожгите мишени огнеметом!", 3000);
                                tutorialStage = 1;
                            }
                            break;
                        case 1: {
                            let allHit = true;
                            for (const t of tutorialTargets) {
                                if (!t.hit) { allHit = false; break; }
                            }
                            if (allHit) {
                                displayTutorialText("Отлично! Потратьте топливо до 0 — на карте появится +30 топлива (подберите: E).", 4500);
                                tutorialStage = 2;
                            }
                            break;
                        }
                        case 2: {
                            const st = (player.weapon === 'flamethrower') ? currentWeapon : (playerWeaponsState['flamethrower'] || null);
                            const ammoVal = st ? st.ammo : null;
                            if (ammoVal === 0 && flameFuelPickups.length > 0) {
                                displayTutorialText("Топливо появилось! Найдите и подберите +30 (подойдите и нажмите E).", 4000);
                                tutorialStage = 3;
                            }
                            break;
                        }
                        case 3: {
                            const st = (player.weapon === 'flamethrower') ? currentWeapon : (playerWeaponsState['flamethrower'] || null);
                            const ammoVal = st ? st.ammo : null;
                            if (ammoVal !== null && ammoVal > 0) {
                                pyroTutorialStartAmmo = ammoVal;
                                displayTutorialText("Теперь используйте СПОСОБНОСТЬ! Нажмите ПКМ — огненный круг даст урон врагам и восстановит топливо (+10/сек).", 5200);
                                // Spawn one enemy to demonstrate circle damage
                                enemies.push(createEnemy(WORLD_WIDTH - 220, WORLD_HEIGHT - 220, 'melee', 0, true));
                                totalEnemies++;
                                tutorialStage = 4;
                            }
                            break;
                        }
                        case 4:
                            if (pyroAura.active) {
                                displayTutorialText("Круг активен! Подождите пару секунд: топливо должно увеличиться, а враг должен погибнуть.", 4200);
                                tutorialStage = 5;
                            }
                            break;
                        case 5: {
                            const st = (player.weapon === 'flamethrower') ? currentWeapon : (playerWeaponsState['flamethrower'] || null);
                            const ammoVal = st ? st.ammo : null;
                            const ammoOk = (pyroTutorialStartAmmo !== null && ammoVal !== null && ammoVal >= pyroTutorialStartAmmo + 10);
                            const enemyOk = (enemies.length === 0);
                            if (ammoOk && enemyOk) {
                                // Same finish behavior as other classes: short message, then return to main menu
                                displayTutorialText("Обучение пройдено! Комбинируйте огнемет и огненный круг для контроля зоны.", 5000);
                                tutorialStage = 9;
                                setTimeout(() => backToMainMenuFromGame(), 5000);
                            }
                            break;
                        }
                    }
                }
            };

            if (tutorials[selectedCharacter]) tutorials[selectedCharacter]();
        }

        function displayTutorialText(text, duration = 0) { tutorialTextElement.textContent = text; tutorialTextElement.style.display = 'block'; if (duration > 0) setTimeout(() => { if (tutorialTextElement.textContent === text && tutorialStage !== 9) tutorialTextElement.style.display = 'none'; }, duration); }

        function createWalls(level) {
            walls.push({ x: 0, y: 0, width: WORLD_WIDTH, height: 30 }, { x: 0, y: WORLD_HEIGHT - 30, width: WORLD_WIDTH, height: 30 }, { x: 0, y: 0, width: 30, height: WORLD_HEIGHT }, { x: WORLD_WIDTH - 30, y: 0, width: 30, height: WORLD_HEIGHT });
            if (level === 0 || level === 5) return;
            const lvl1 = [{ x: 800, y: 300, width: 30, height: 500 }, { x: 600, y: 600, width: 400, height: 30 }, { x: 1500, y: 800, width: 30, height: 300 }];
            const lvl2 = [{ x: 500, y: 100, width: 30, height: 300 }, { x: 1600, y: 600, width: 30, height: 400 }, { x: 1000, y: 900, width: 400, height: 30 }];
            const lvl3 = [{ x: 1000, y: 100, width: 30, height: 600 }, { x: 1500, y: 300, width: 30, height: 800 }, { x: 300, y: 400, width: 400, height: 30 }];
            const lvl4 = [{ x: 2000, y: 400, width: 30, height: 700 }, { x: 1300, y: 700, width: 400, height: 30 }, { x: 300, y: 700, width: 30, height: 450 }];
            if (level >= 1) walls.push(...lvl1);
            if (level >= 2) walls.push(...lvl2);
            if (level >= 3) walls.push(...lvl3);
            if (level >= 4) walls.push(...lvl4);
        }

        // Chapter 2 Level 1: HoTRoD — chaotic interior walls (no closed "square rooms")
        function createHotrodRoom() {
            walls = [];
            obstacles = [];

            // Outer bounds (thicker)
            const t = 40;
            walls.push(
                { x: 0, y: 0, width: WORLD_WIDTH, height: t },
                { x: 0, y: WORLD_HEIGHT - t, width: WORLD_WIDTH, height: t },
                { x: 0, y: 0, width: t, height: WORLD_HEIGHT },
                { x: WORLD_WIDTH - t, y: 0, width: t, height: WORLD_HEIGHT }
            );

            // Clear spawn/start zone (top-left-ish). Keep this area free.
            const startZone = { x: 120, y: 120, w: 560, h: 380 };

            // Generate many disconnected wall segments (avoid forming boxes)
            const segments = [];
            const pad = 110; // larger gap to avoid forming closed rooms

            const intersects = (a, b, p = 0) => !(
                a.x + a.width + p < b.x ||
                a.x > b.x + b.width + p ||
                a.y + a.height + p < b.y ||
                a.y > b.y + b.height + p
            );

            const intersectsStart = (s) => intersects(s, startZone, 0);
            const intersectsAny = (s) => segments.some(ex => intersects(s, ex, pad));

            const segCount = 22;
            for (let i = 0; i < segCount; i++) {
                let attempts = 0;
                let s = null;

                while (attempts++ < 120) {
                    const vertical = Math.random() < 0.58;
                    const thickness = 22 + Math.floor(Math.random() * 14);
                    const len = 140 + Math.floor(Math.random() * 560);

                    const width = vertical ? thickness : len;
                    const height = vertical ? len : thickness;

                    const x = t + 70 + Math.random() * (WORLD_WIDTH - (t + 140) - width);
                    const y = t + 70 + Math.random() * (WORLD_HEIGHT - (t + 140) - height);

                    s = { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) };
                    if (intersectsStart(s)) continue;
                    if (intersectsAny(s)) continue;
                    break;
                }

                if (!s) continue;
                // final safety
                if (intersectsStart(s)) continue;
                if (intersectsAny(s)) continue;
                segments.push(s);
            }

            walls.push(...segments);
        }

        // Chapter 2 Level 2: Skyward Ascent — daytime rooftops (horizontal rooftops)
        function createSkywardLevel() {
            walls = [];
            obstacles = [];
            skywardDecor = { buildings: [], bridges: [] };
            skywardWalkZones = [];

            // IMPORTANT:
            // No outer bounds for this level.
            // Walking is restricted to rooftops + planks via skywardWalkZones.
            // Skyler's dash is allowed to cross gaps.

            // Rooftops: long, wide buildings arranged left -> right
            // Keep within enlarged WORLD_WIDTH
            const roofY = 360;
            const roofH = 900;   // выше, больше пространства для боя
            const startX = 120;
            const roofW = 580;   // длиннее по горизонтали
            const gap = 160;     // заметные зазоры между крышами

            for (let i = 0; i < 5; i++) {
                const x = startX + i * (roofW + gap);
                const building = { x, y: roofY, w: roofW, h: roofH };
                skywardDecor.buildings.push(building);
                skywardWalkZones.push({ x, y: roofY, w: roofW, h: roofH });

                // Rooftop cover props (physical), больше препятствий на каждой крыше
                const palette = {
                    box: '#d6dde6',
                    pipe: '#8b97a6',
                    vent: '#c0c8d4'
                };

                const props = [];
                // крупный ящик ближе к левому краю
                props.push({ x: x + 80, y: roofY + 120, w: 96, h: 96, color: palette.box });
                // длинная труба у правого края
                props.push({ x: x + roofW - 260, y: roofY + 150, w: 190, h: 30, color: palette.pipe });
                // нижняя труба / парапет
                props.push({ x: x + 90, y: roofY + roofH - 140, w: 240, h: 26, color: palette.pipe });
                // вент или блок оборудования
                props.push({ x: x + roofW - 190, y: roofY + roofH * 0.6, w: 110, h: 110, color: palette.vent });

                // Дополнительные случайные ящики для укрытия
                for (let k = 0; k < 3; k++) {
                    const rw = 70 + Math.random() * 90;
                    const rh = 50 + Math.random() * 80;
                    const rx = x + 60 + Math.random() * (roofW - 160 - rw);
                    const ry = roofY + 140 + Math.random() * (roofH - 260 - rh);
                    props.push({ x: rx, y: ry, w: rw, h: rh, color: palette.box });
                }

                for (const p of props) {
                    const ob = { x: p.x, y: p.y, width: p.w, height: p.h, type: 'table', color: p.color };
                    obstacles.push(ob);
                    walls.push({ x: ob.x, y: ob.y, width: ob.width, height: ob.height });
                }
            }

            // Between building 1 and 2: two pallet planks (walkable + visible)
            const b1 = skywardDecor.buildings[0];
            const b2 = skywardDecor.buildings[1];
            const gapX = b1.x + b1.w;
            const gapW = (b2.x - (b1.x + b1.w));

            const overlap = 36; // небольшой нахлёст на крыши
            const plankH = 70;
            const plankW = gapW + overlap * 2;
            const plankX = gapX - overlap;

            const plank1 = { x: plankX, y: roofY + 150, w: plankW, h: plankH, kind: 'pallet' };
            const plank2 = { x: plankX, y: roofY + 320, w: plankW, h: plankH, kind: 'pallet' };
            skywardDecor.bridges.push(plank1, plank2);
            skywardWalkZones.push({ x: plank1.x, y: plank1.y, w: plank1.w, h: plank1.h });
            skywardWalkZones.push({ x: plank2.x, y: plank2.y, w: plank2.w, h: plank2.h });

            // Player start on the first roof (slightly deeper on a taller roof)
            player.x = b1.x + 180;
            player.y = roofY + 360;

            // Враги по зданиям: каждый стоит на своём доме и стреляет
            enemies = [];
            enemyBullets = [];
            bullets = [];
            weaponPickups = [];

            const roofs = skywardDecor.buildings;

            // Здание 1 (index 0): никого

            // Здание 2 (index 1): 4 shooter (ranged), без выхода на доски
            if (roofs[1]) {
                const r2 = roofs[1];
                const cx2 = r2.x + r2.w / 2;
                const topY2 = roofY + 200;
                const midY2 = roofY + roofH * 0.55;

                // все противники — стрелки, ходят только по своей крыше
                const home2 = { minX: r2.x, maxX: r2.x + r2.w, minY: roofY, maxY: roofY + roofH };

                let e21 = createEnemy(cx2 - 90, topY2, 'ranged', 4, false);
                let e22 = createEnemy(cx2 + 90, topY2, 'ranged', 4, false);
                e21.home = home2;
                e22.home = home2;
                enemies.push(e21);
                enemies.push(e22);

                let e23 = createEnemy(cx2 - 180, midY2, 'ranged', 4, false);
                let e24 = createEnemy(cx2 + 180, midY2, 'ranged', 4, false);
                e23.home = home2;
                e24.home = home2;
                enemies.push(e23);
                enemies.push(e24);
            }

            // Здание 3 (index 2): 2 shooter (ranged) и 2 sniper
            if (roofs[2]) {
                const r3 = roofs[2];
                const cx3 = r3.x + r3.w / 2;
                const topY3 = roofY + 210;
                const midY3 = roofY + roofH * 0.52;

                // ranged ближе к центру
                let e31 = createEnemy(cx3 - 140, midY3, 'ranged', 4, false);
                let e32 = createEnemy(cx3 + 140, midY3, 'ranged', 4, false);
                e31.home = { minX: r3.x, maxX: r3.x + r3.w, minY: roofY, maxY: roofY + roofH };
                e32.home = { minX: r3.x, maxX: r3.x + r3.w, minY: roofY, maxY: roofY + roofH };
                enemies.push(e31);
                enemies.push(e32);

                // sniper чуть дальше, ближе к верхнему краю
                let e33 = createEnemy(cx3 - 220, topY3, 'sniper', 4, false);
                let e34 = createEnemy(cx3 + 220, topY3, 'sniper', 4, false);
                e33.home = { minX: r3.x, maxX: r3.x + r3.w, minY: roofY, maxY: roofY + roofH };
                e34.home = { minX: r3.x, maxX: r3.x + r3.w, minY: roofY, maxY: roofY + roofH };
                enemies.push(e33);
                enemies.push(e34);
            }

            // Здание 4 (index 3): 2 miniganer и 1 shooter (ranged)
            if (roofs[3]) {
                const r4 = roofs[3];
                const cx4 = r4.x + r4.w / 2;
                const topY4 = roofY + 230;
                const midY4 = roofY + roofH * 0.6;

                const home4 = { minX: r4.x, maxX: r4.x + r4.w, minY: roofY, maxY: roofY + roofH };

                // miniganer по краям
                let e41 = createEnemy(cx4 - 200, topY4, 'miniganer', 4, false);
                let e42 = createEnemy(cx4 + 200, topY4, 'miniganer', 4, false);
                e41.home = home4;
                e42.home = home4;
                enemies.push(e41);
                enemies.push(e42);

                // shooter (ranged) в центре, чуть ниже
                let e43 = createEnemy(cx4, midY4, 'ranged', 4, false);
                e43.home = home4;
                enemies.push(e43);
            }

            // Здание 5 (index 4): уже были противники — оставляем 3 турели Gunnest
            if (roofs[4]) {
                const r5 = roofs[4];
                const gx = r5.x + r5.w - 180;
                const gy1 = roofY + 220;
                const gy2 = roofY + Math.floor(roofH * 0.55);
                const gy3 = roofY + roofH - 220;

                let g1 = createEnemy(gx, gy1, 'gunnest', 4, false);
                let g2 = createEnemy(gx, gy2, 'gunnest', 4, false);
                let g3 = createEnemy(gx, gy3, 'gunnest', 4, false);
                const home5 = { minX: r5.x, maxX: r5.x + r5.w, minY: roofY, maxY: roofY + roofH };
                g1.home = home5; g2.home = home5; g3.home = home5;
                // дальнобойные, с большим разбросом
                g1.range = 1400; g2.range = 1400; g3.range = 1400;
                g1.cone = 0.95; g2.cone = 0.95; g3.cone = 0.95;
                g1.shootInterval = 60; g2.shootInterval = 60; g3.shootInterval = 60;
                enemies.push(g1);
                enemies.push(g2);
                enemies.push(g3);
            }

            totalEnemies = enemies.length;
        }

        function createBoss() { boss = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, radius: 40, hp: 2000, maxHP: 2000, phase: 1, attackTimer: 0, attackType: 0, rotation: 0, color: '#ff0000', speed: 1.2, targetX: WORLD_WIDTH / 2, targetY: WORLD_HEIGHT / 2, moveTimer: 0 }; totalEnemies = 1; }

        function createMiniBoss() {
            const side = Math.floor(Math.random() * 4), coords = [[100, WORLD_HEIGHT / 2], [WORLD_WIDTH - 100, WORLD_HEIGHT / 2], [WORLD_WIDTH / 2, 100], [WORLD_WIDTH / 2, WORLD_HEIGHT - 100]][side];
            miniBoss = { x: coords[0], y: coords[1], radius: 15, hp: 1000, maxHP: 1000, attackTimer: 0, attackType: 0, color: '#888888', speed: 2.4, targetX: player.x, targetY: player.y, isDashing: false, dashTimer: 0, isTired: false, tiredTimer: 0, rotation: 0, pathfindTimer: 0, lastX: coords[0], lastY: coords[1], unstuckTimer: 0, walkTimer: 0 };
            document.getElementById('miniBossHealth').style.display = 'block'; updateMiniBossHealthBar(); totalEnemies++;
        }

        function updateMiniBoss() {
            if (!miniBoss) return;

            if (miniBoss.isTired) {
                miniBoss.tiredTimer--;
                if (miniBoss.tiredTimer <= 0) miniBoss.isTired = false;
                return;
            }

            if (miniBoss.isDashing) {
                miniBoss.dashTimer--;
                const angle = Math.atan2(miniBoss.targetY - miniBoss.y, miniBoss.targetX - miniBoss.x);
                const newX = miniBoss.x + Math.cos(angle) * miniBoss.speed * 3;
                const newY = miniBoss.y + Math.sin(angle) * miniBoss.speed * 3;

                if (!checkWallCollision(newX, newY, miniBoss.radius)) {
                    miniBoss.x = newX;
                    miniBoss.y = newY;
                }

                const dist = Math.hypot(player.x - miniBoss.x, player.y - miniBoss.y);
                if (dist < player.radius + miniBoss.radius) {
                    // Tank shield OR Skyler dash grant full damage immunity
                    if (!(abilityActive && selectedCharacter === 'tank') && !(selectedCharacter === 'skyler' && skylerDash.invulnT > 0)) {
                        player.hp -= 20;
                        updateHUD();
                    }
                }

                for (let i = obstacles.length - 1; i >= 0; i--) {
                    const obs = obstacles[i], obsX = obs.x + obs.width / 2, obsY = obs.y + obs.height / 2;
                    if (Math.hypot(miniBoss.x - obsX, miniBoss.y - obsY) < miniBoss.radius + Math.max(obs.width, obs.height) / 2) {
                        obstacles.splice(i, 1);
                        for (let j = walls.length - 1; j >= 0; j--) {
                            if (walls[j].x === obs.x && walls[j].y === obs.y) {
                                walls.splice(j, 1);
                                break;
                            }
                        }
                    }
                }

                if (miniBoss.dashTimer <= 0) {
                    miniBoss.isDashing = false;
                    miniBoss.isTired = true;
                    miniBoss.tiredTimer = 120;
                }
                return;
            }

            const dist = Math.hypot(player.x - miniBoss.x, player.y - miniBoss.y);
            const optimalDistance = 300;
            const angleToPlayer = Math.atan2(player.y - miniBoss.y, player.x - miniBoss.x);

            miniBoss.walkTimer++;
            if (dist > optimalDistance + 80) {
                const newX = miniBoss.x + Math.cos(angleToPlayer) * miniBoss.speed;
                const newY = miniBoss.y + Math.sin(angleToPlayer) * miniBoss.speed;
                if (!checkWallCollision(newX, newY, miniBoss.radius)) {
                    miniBoss.x = newX;
                    miniBoss.y = newY;
                }
            } else if (dist < optimalDistance - 80) {
                const newX = miniBoss.x - Math.cos(angleToPlayer) * miniBoss.speed;
                const newY = miniBoss.y - Math.sin(angleToPlayer) * miniBoss.speed;
                if (!checkWallCollision(newX, newY, miniBoss.radius)) {
                    miniBoss.x = newX;
                    miniBoss.y = newY;
                }
            }

            miniBoss.attackTimer++;
            if (miniBoss.attackTimer > 60) {
                miniBoss.attackType = Math.random() < 0.85 ? 0 : 1;
                miniBoss.attackTimer = 0;

                if (miniBoss.attackType === 0) {
                    const angleToPlayer2 = Math.atan2(player.y - miniBoss.y, player.x - miniBoss.x);
                    for (let gun = 0; gun < 2; gun++) {
                        const gunOffset = gun === 0 ? -0.15 : 0.15;
                        for (let i = 0; i < 3; i++) {
                            setTimeout(() => {
                                if (miniBoss) {
                                    enemyBullets.push({
                                        x: miniBoss.x,
                                        y: miniBoss.y,
                                        radius: 6,
                                        speedX: Math.cos(angleToPlayer2 + gunOffset) * 7,
                                        speedY: Math.sin(angleToPlayer2 + gunOffset) * 7,
                                        damage: 15,
                                        color: '#FFD700',
                                        destroyObstacles: true,
                                        bounces: 3
                                    });
                                }
                            }, i * 120 + gun * 60);
                        }
                    }
                } else if (miniBoss.attackType === 1 && dist > 200) {
                    miniBoss.isDashing = true;
                    miniBoss.dashTimer = 25;
                    miniBoss.targetX = player.x;
                    miniBoss.targetY = player.y;
                }
            }

            for (let i = bullets.length - 1; i >= 0; i--) {
                const dist = Math.hypot(bullets[i].x - miniBoss.x, bullets[i].y - miniBoss.y);
                if (dist < bullets[i].radius + miniBoss.radius) {
                    miniBoss.hp -= bullets[i].damage;
                    bullets.splice(i, 1);
                    updateMiniBossHealthBar();

                    if (miniBoss.hp <= 0) {
                        miniBossDefeated();
                    }
                }
            }
        }

        function updateMiniBossHealthBar() { if (!miniBoss) return; document.getElementById('miniBossHealthFill').style.width = Math.max(0, miniBoss.hp / miniBoss.maxHP) * 100 + '%'; }
        function miniBossDefeated() {
            miniBoss = null;
            document.getElementById('miniBossHealth').style.display = 'none';
            kills++;
            updateHUD();
            if (currentLevel !== 0 && enemies.length === 0 && !boss) {
                levelComplete();
            }
        }

        function createEnemies(level) {
            const enemyCount = { 1: 10, 2: 15, 3: 18, 4: 20 }[level] || 6 + level * 3;
            totalEnemies = enemyCount; mainEnemiesDefeated = false;
            const enemyTypes = ['melee', 'ranged', 'sniper', 'tank', 'ambush'];
            for (let i = 0; i < enemyCount; i++) {
                let x, y, attempts = 0;
                do {
                    x = Math.random() * (WORLD_WIDTH - 600) + 300;
                    y = Math.random() * (WORLD_HEIGHT - 600) + 300;
                    attempts++;
                } while ((Math.hypot(x - player.x, y - player.y) < 400 || isEnemyPositionBlocked(x, y, 12)) && attempts < 200);
                if (attempts >= 200) continue;
                let type; const rand = Math.random();
                if (level === 1) type = rand < 0.6 ? 'melee' : 'ranged';
                else if (level === 2) type = rand < 0.3 ? 'melee' : rand < 0.7 ? 'ranged' : 'ambush';
                else if (level === 3) type = rand < 0.2 ? 'melee' : rand < 0.5 ? 'ranged' : rand < 0.8 ? 'sniper' : 'ambush';
                else type = enemyTypes[Math.floor(Math.random() * enemyTypes.length)];
                enemies.push(createEnemy(x, y, type, level, false));
            }
        }

        // Chapter 2 Level 1 enemy pack (HoTRoD)
        // First wave: 20 enemies (NO melee/sniper/miniganer). Final wave: 5 miniganer.
        function createEnemiesHotrod() {
            const firstWaveCount = 20;
            totalEnemies = 25; // 20 + 5 miniganer at the end
            mainEnemiesDefeated = false;

            const mix = [
                { type: 'ranged', w: 0.48 },
                { type: 'tank', w: 0.18 },
                { type: 'ambush', w: 0.34 }
            ];

            function pickType() {
                const r = Math.random();
                let acc = 0;
                for (const m of mix) {
                    acc += m.w;
                    if (r <= acc) return m.type;
                }
                return 'ranged';
            }

            for (let i = 0; i < firstWaveCount; i++) {
                let x, y, attempts = 0;
                do {
                    x = Math.random() * (WORLD_WIDTH - 900) + 450;
                    y = Math.random() * (WORLD_HEIGHT - 700) + 350;
                    attempts++;
                } while ((Math.hypot(x - player.x, y - player.y) < 360 || isEnemyPositionBlocked(x, y, 14)) && attempts < 260);
                if (attempts >= 260) {
                    const pos = getRandomFreePosition();
                    x = pos.x; y = pos.y;
                }
                enemies.push(createEnemy(x, y, pickType(), 4, false));
            }
        }

        function spawnHotrodFinalWaveMiniganers(count = 5) {
            // spawn from edges/outer ring so it feels like an "ending wave"
            for (let i = 0; i < count; i++) {
                let x = 0, y = 0;
                let attempts = 0;
                while (attempts++ < 220) {
                    const side = Math.floor(Math.random() * 4);
                    if (side === 0) { x = 120; y = 160 + Math.random() * (WORLD_HEIGHT - 320); }
                    else if (side === 1) { x = WORLD_WIDTH - 120; y = 160 + Math.random() * (WORLD_HEIGHT - 320); }
                    else if (side === 2) { x = 160 + Math.random() * (WORLD_WIDTH - 320); y = 120; }
                    else { x = 160 + Math.random() * (WORLD_WIDTH - 320); y = WORLD_HEIGHT - 120; }

                    if (Math.hypot(x - player.x, y - player.y) < 520) continue;
                    if (checkWallCollision(x, y, 18)) continue;
                    break;
                }
                if (attempts >= 220) {
                    const pos = getRandomFreePosition();
                    x = pos.x; y = pos.y;
                }
                enemies.push(createEnemy(x, y, 'miniganer', 4, false));
            }
        }

        function createEnemy(x, y, type, level, isTutorialEnemy = false) {
            const data = {
                melee: { color: '#ff8800', speed: (3.5 + level * 0.4) * 1.6, hp: 40 + level * 15, damage: 0.8, radius: 12, groupRange: 200 },
                ranged: { color: '#0088ff', speed: 2.5 * 2, hp: 35 + level * 10, shootInterval: 1500 - level * 100, radius: 11, flankTimer: 0, flankAngle: Math.random() * Math.PI * 2 },
                sniper: { color: '#ff00ff', speed: 1.7 * 2, hp: 30 + level * 8, shootInterval: 2500 - level * 200, radius: 10, range: 800, retreatMode: false },
                tank: { color: '#888888', speed: 1.5 * 2.3, hp: 100 + level * 30, damage: 1.2, radius: 18 },
                // Ambush: fastest chaser, should reliably catch up to the player
                ambush: { color: '#8800ff', speed: (4.8 + level * 0.4) * 1.9, hp: 25 + level * 8, radius: 11, waiting: false, activated: true },
                // Chapter 2: Miniganer — medium unit with a machinegun stream (shoots only on sight)
                miniganer: { color: '#b5b5b5', speed: 1.35 * 2.0, hp: 200, shootInterval: 140, radius: 16, range: 820, damage: 5, cone: 0.38 },

                // Chapter 2: Gunnest — stationary turret enemy (looks like a gray unit behind a turret)
                gunnest: { color: '#9ca3af', speed: 0, hp: 150, shootInterval: 70, radius: 16, range: 980, damage: 5, cone: 0.55 }
            }[type];
            return { id: enemyIdCounter++, x, y, radius: data.radius, speed: isTutorialEnemy ? 0 : data.speed, hp: data.hp, maxHP: data.hp, type, color: data.color, lastShot: 0, shootInterval: data.shootInterval || 2000, damage: data.damage || 0.5, range: data.range || 600, cone: data.cone || 0, waiting: data.waiting || false, activated: data.activated !== undefined ? data.activated : true, pathfindTimer: 0, targetX: x, targetY: y, stuck: 0, lastX: x, lastY: y, unstuckTimer: 0, groupRange: data.groupRange || 0, flankTimer: data.flankTimer || 0, flankAngle: data.flankAngle || 0, retreatMode: data.retreatMode || false, isTutorialEnemy,
                // Gunnest firing cycle (10s firing, then reload pause)
                gunActiveT: 0,
                gunReloadT: 0
            };
        }

        function getRandomFreePosition() { let x, y, attempts = 0; do { x = Math.random() * (WORLD_WIDTH - 200) + 100; y = Math.random() * (WORLD_HEIGHT - 200) + 100; attempts++; } while ((checkWallCollision(x, y, 20) || Math.hypot(x - player.x, y - player.y) < 300) && attempts < 200); return { x, y }; }

// Helper: prevent enemies from spawning inside walls/obstacles on any level
function isEnemyPositionBlocked(x, y, radius = 12) {
    if (checkWallCollision(x, y, radius)) return true;
    const r2 = radius * radius;
    for (const o of obstacles) {
        const closestX = Math.max(o.x, Math.min(x, o.x + o.width));
        const closestY = Math.max(o.y, Math.min(y, o.y + o.height));
        const dx = x - closestX;
        const dy = y - closestY;
        if (dx * dx + dy * dy < r2) return true;
    }
    return false;
}

        function createWeaponPickups(level) {
            const configs = { 1: { shotgun: 2, smg: 1 }, 2: { shotgun: 2, rifle: 1, smg: 1 }, 3: { shotgun: 2, rifle: 1, smg: 1, sniper: 1 }, 4: { shotgun: 2, rifle: 1, smg: 1, sniper: 1 } };
            if (configs[level]) for (const [type, count] of Object.entries(configs[level])) for (let i = 0; i < count; i++) { const pos = getRandomFreePosition(); createWeaponPickup(type, pos.x, pos.y); }
        }

        // Chapter 2 Level 1: HoTRoD weapon pickups (only shotgun + smg)
        function createWeaponPickupsHotrod() {
            const configs = { shotgun: 3, smg: 2 };
            for (const [type, count] of Object.entries(configs)) {
                for (let i = 0; i < count; i++) {
                    const pos = getRandomFreePosition();
                    createWeaponPickup(type, pos.x, pos.y);
                }
            }

            // A few grenade pickups around the arena
            for (let i = 0; i < 4; i++) {
                const pos = getRandomFreePosition();
                createGrenadePickup(pos.x, pos.y, 1);
            }
        }

        // Chapter 2 Level 1: HoTRoD — cover props (PHYSICAL) with enough space to move
        function createHotrodObstacles() {
            // Important: createHotrodRoom() sets walls = [outer + random segments] and clears obstacles.
            // Here we add cover props that MUST be physical, so we also add their colliders into `walls`.
            // They remain destructible because explosions remove both from `obstacles` and `walls`.

            const count = 46; // moderate density (more space to move)

            // Keep the start zone and a broad mid-lane relatively open
            const startZone = { x: 120, y: 120, w: 560, h: 380 };
            const midLane = { x: 720, y: 440, w: 980, h: 680 };

            const overlapsRect = (x, y, w, h, r) => !(
                x + w < r.x ||
                x > r.x + r.w ||
                y + h < r.y ||
                y > r.y + r.h
            );

            for (let i = 0; i < count; i++) {
                let x, y, attempts = 0;

                // Balanced prop sizes (avoid huge blockers)
                let w = 34 + Math.random() * 90;
                let h = 34 + Math.random() * 90;

                // Some long cover (rare)
                if (Math.random() < 0.16) {
                    w = 120 + Math.random() * 170;
                    h = 18 + Math.random() * 26;
                }

                do {
                    x = 110 + Math.random() * (WORLD_WIDTH - 220 - w);
                    y = 110 + Math.random() * (WORLD_HEIGHT - 220 - h);
                    attempts++;

                    // Keep start open; keep lane semi-open (allow some props there, but less often)
                    const inStart = overlapsRect(x, y, w, h, startZone);
                    const inLane = overlapsRect(x, y, w, h, midLane);
                    if (inLane && Math.random() < 0.72) continue;

                    if (inStart) continue;

                } while (
                    (Math.hypot(x - player.x, y - player.y) < 240 || checkObstacleOverlapLoose(x, y, w, h))
                    && attempts < 260
                );

                if (attempts >= 260) continue;

                const typePool = ['box', 'barrel', 'table', 'column'];
                const type = typePool[Math.floor(Math.random() * typePool.length)];
                const palette = {
                    box: '#4a3f22',
                    barrel: '#3a3a3a',
                    table: '#2b2f34',
                    column: '#4a5450'
                };

                const ob = { x, y, width: w, height: h, type, color: palette[type] || '#666' };
                obstacles.push(ob);
                // Make physical
                walls.push({ x: ob.x, y: ob.y, width: ob.width, height: ob.height });
            }
        }

        // Overlap helper for HoTRoD obstacles (doesn't consider 'walls' as padding too aggressively)
        function checkObstacleOverlapLoose(x, y, w, h) {
            // Keep some spacing between props; allow near walls.
            const pad = 22;
            for (let o of obstacles) {
                if (x < o.x + o.width + pad && x + w > o.x - pad && y < o.y + o.height + pad && y + h > o.y - pad) return true;
            }
            return false;
        }

        function createGrenadePickup(x, y, amount = 1) {
            grenadePickups.push({ x, y, radius: 18, amount: Math.max(1, amount) });
        }

        // HoTRoD: explosive red barrels (3 bullet hits -> explode)
        function spawnExplosiveBarrelsHotrod(count = 7) {
            explosiveBarrels = [];
            for (let i = 0; i < count; i++) {
                let x, y, attempts = 0;
                const w = 36, h = 36;
                do {
                    x = 420 + Math.random() * (WORLD_WIDTH - 840);
                    y = 320 + Math.random() * (WORLD_HEIGHT - 640);
                    attempts++;
                } while ((checkObstacleOverlap(x, y, w, h) || Math.hypot(x - player.x, y - player.y) < 220) && attempts < 220);

                if (attempts >= 220) {
                    const pos = getRandomFreePosition();
                    x = pos.x; y = pos.y;
                }

                const barrel = {
                    x,
                    y,
                    width: w,
                    height: h,
                    type: 'explosive_barrel',
                    color: '#c40000',
                    hits: 0,
                    hitsToExplode: 3,
                    damage: 100,
                    explosionRadius: 190
                };

                obstacles.push(barrel);
                // Important: barrel must block movement like an obstacle
                walls.push({ x: barrel.x, y: barrel.y, width: barrel.width, height: barrel.height });
                explosiveBarrels.push(barrel);
            }
        }

        function createWeaponPickup(weaponType, x, y) {
            let weaponData = { ...weapons[weaponType] };
            if (selectedCharacter === 'ammo' && weaponData.ammo !== Infinity) weaponData.ammo = (weaponData.originalAmmo !== undefined ? weaponData.originalAmmo : weaponData.ammo) * 2;
            weaponPickups.push({ x, y, radius: 20, weaponType, weapon: weaponData });
        }

        function spawnBossWeapon() { const types = ['shotgun', 'rifle', 'smg', 'sniper'], pos = getRandomFreePosition(); createWeaponPickup(types[Math.floor(Math.random() * types.length)], pos.x, pos.y); }

        function spawnFlameFuelPickup(amount = 30) {
            // Spawn a fuel orb somewhere on the map (NOT near the player)
            let x = 0, y = 0;
            let attempts = 0;
            const minDist = 700;

            do {
                x = Math.random() * (WORLD_WIDTH - 200) + 100;
                y = Math.random() * (WORLD_HEIGHT - 200) + 100;
                attempts++;
            } while ((checkWallCollision(x, y, 22) || Math.hypot(x - player.x, y - player.y) < minDist) && attempts < 260);

            // Fallback: at least some free position (even if not far enough)
            if (attempts >= 260) {
                const pos = getRandomFreePosition();
                x = pos.x;
                y = pos.y;
            }

            // Always spawn a fixed +30 fuel pickup (no randomness)
            const fixedAmount = 30;
            flameFuelPickups.push({ x, y, radius: 18, amount: fixedAmount });
        }

        function pickupWeapon() {
            // First: flamethrower fuel
            for (let i = flameFuelPickups.length - 1; i >= 0; i--) {
                const f = flameFuelPickups[i];
                if (Math.hypot(player.x - f.x, player.y - f.y) < player.radius + f.radius + 20) {
                    // Only if the player actually HAS the flamethrower in this run
                    const st = playerWeaponsState['flamethrower'] || (player.weapon === 'flamethrower' ? currentWeapon : null);
                    if (st && st.ammo !== Infinity) {
                        // Cap at 100 (fixed tank size). Always add exactly +30.
                        const gain = 30;
                        st.ammo = Math.min(100, (st.ammo || 0) + gain);
                        // Persist in state
                        playerWeaponsState['flamethrower'] = { ...st };
                        // If currently holding flamethrower, sync currentWeapon too
                        if (player.weapon === 'flamethrower') {
                            currentWeapon.ammo = st.ammo;
                        }
                        flameFuelPickups.splice(i, 1);
                        flameFuelSpawnedThisZero = false;
                        updateHUD();
                        playSound('pew');
                    }
                }
            }

            // Second: grenade pickups (HoTRoD)
            for (let i = grenadePickups.length - 1; i >= 0; i--) {
                const g = grenadePickups[i];
                if (Math.hypot(player.x - g.x, player.y - g.y) < player.radius + g.radius + 20) {
                    meshGrenadeCount += (g.amount || 1);
                    grenadePickups.splice(i, 1);

                    // Update ability text for MESH
                    if (selectedCharacter === 'mesh') {
                        document.getElementById('abilityStatus').style.display = 'block';
                        document.getElementById('abilityText').textContent = `Готова (ПКМ) x${meshGrenadeCount}`;
                        document.getElementById('abilityText').style.color = '#00ff00';
                    }
                    playSound('pew');
                }
            }

            // Then: normal weapons
            for (let i = weaponPickups.length - 1; i >= 0; i--) {
                const p = weaponPickups[i];
                if (Math.hypot(player.x - p.x, player.y - p.y) < player.radius + p.radius + 20) {
                    // Save pickup weapon state (ammo etc.) and equip
                    playerWeaponsState[p.weaponType] = { ...p.weapon };
                    equipWeapon(p.weaponType);
                    weaponPickups.splice(i, 1);
                    playSound('pew');
                }
            }
        }

        function hasLineOfSight(x1, y1, x2, y2) { const steps = 50, dx = (x2 - x1) / steps, dy = (y2 - y1) / steps; for (let i = 0; i < steps; i++) if (checkWallCollision(x1 + dx * i, y1 + dy * i, 5)) return false; return true; }

        function findPath(enemy) {
            if (Math.hypot(enemy.x - enemy.lastX, enemy.y - enemy.lastY) < 1) {
                enemy.unstuckTimer++;
                if (enemy.unstuckTimer > 10) {
                    const a = Math.random() * Math.PI * 2;
                    enemy.targetX = enemy.x + Math.cos(a) * 200;
                    enemy.targetY = enemy.y + Math.sin(a) * 200;
                    enemy.unstuckTimer = 0;
                    return;
                }
            } else enemy.unstuckTimer = 0;
            enemy.lastX = enemy.x; enemy.lastY = enemy.y;

            if (enemy.type === 'melee' || enemy.type === 'tank') {
                enemy.targetX = player.x;
                enemy.targetY = player.y;
                const directAngle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
                const testDist = 60;
                const testX = enemy.x + Math.cos(directAngle) * testDist;
                const testY = enemy.y + Math.sin(directAngle) * testDist;
                if (checkWallCollision(testX, testY, enemy.radius)) {
                    const angles = [
                        directAngle + Math.PI/3, directAngle - Math.PI/3,
                        directAngle + Math.PI/2, directAngle - Math.PI/2,
                        directAngle + Math.PI * 2/3, directAngle - Math.PI * 2/3
                    ];
                    for (let a of angles) {
                        const tx = enemy.x + Math.cos(a) * 150;
                        const ty = enemy.y + Math.sin(a) * 150;
                        if (!checkWallCollision(tx, ty, enemy.radius)) {
                            enemy.targetX = tx;
                            enemy.targetY = ty;
                            return;
                        }
                    }
                }
            }
            else if (enemy.type === 'ranged') { enemy.flankTimer++; if (enemy.flankTimer > 90) { enemy.flankAngle = Math.atan2(player.y - enemy.y, player.x - enemy.x) + (Math.random() > 0.5 ? Math.PI/2 : -Math.PI/2); enemy.flankTimer = 0; } const flankDist = 300; enemy.targetX = player.x + Math.cos(enemy.flankAngle) * flankDist; enemy.targetY = player.y + Math.sin(enemy.flankAngle) * flankDist; }
            else if (enemy.type === 'sniper') { const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y); if (dist < 400 && !enemy.retreatMode) { const a = Math.atan2(enemy.y - player.y, enemy.x - player.x); enemy.targetX = enemy.x + Math.cos(a) * 250; enemy.targetY = enemy.y + Math.sin(a) * 250; enemy.retreatMode = true; } else if (dist > 600 && enemy.retreatMode) { enemy.retreatMode = false; enemy.targetX = player.x; enemy.targetY = player.y; } else if (!enemy.retreatMode) { enemy.targetX = player.x; enemy.targetY = player.y; } }
            else if (enemy.type === 'ambush' && enemy.activated) { enemy.targetX = player.x; enemy.targetY = player.y; }
        }

        function angleDiff(a, b) {
            let d = a - b;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            return d;
        }

        /* =======================
           HoTRoD intro cutscene (level 101)
           - Stage 0: Jack enters, camera follows
           - Stage 1: Wide shot of the arena
           - Stage 2: Red SHOW TIME
           Skip: E / У
        ======================= */
        function lerp(a, b, t) { return a + (b - a) * t; }

        function startHotrodCutscene() {
            if (currentLevel !== 101) return;
            hotrodCutscene.active = true;
            hotrodCutscene.stage = 0;
            hotrodCutscene.stageT = 0;

            // Store current camera, to restore smoothly
            hotrodCutscene.camFromX = camera.x;
            hotrodCutscene.camFromY = camera.y;

            // Lock gameplay input/state during cutscene
            gameState = 'cutscene';

            // Place Jack just outside the start zone and make him "walk in"
            player.x = 120;
            player.y = 260;

            // Set initial camera to see the entrance
            camera.x = Math.max(0, Math.min(player.x - canvas.width * 0.5, WORLD_WIDTH - canvas.width));
            camera.y = Math.max(0, Math.min(player.y - canvas.height * 0.5, WORLD_HEIGHT - canvas.height));
            camera.shakeX = 0; camera.shakeY = 0; camera.shakeDuration = 0; camera.shakePower = 10;
        }

        function endHotrodCutscene() {
            hotrodCutscene.active = false;
            hotrodCutscene.stage = 0;
            hotrodCutscene.stageT = 0;
            // Back to gameplay
            gameState = 'playing';
            // Ensure camera is centered on player for gameplay
            camera.x = Math.max(0, Math.min(player.x - canvas.width / 2, WORLD_WIDTH - canvas.width));
            camera.y = Math.max(0, Math.min(player.y - canvas.height / 2, WORLD_HEIGHT - canvas.height));
        }

        function skipHotrodCutscene() {
            if (!hotrodCutscene.active) return;
            // Put Jack into the intended spawn position
            player.x = 260;
            player.y = 240;
            endHotrodCutscene();
        }

        function updateHotrodCutscene() {
            // 60fps timebase
            hotrodCutscene.stageT++;

            // Stage 0: walk in (~2.2s)
            if (hotrodCutscene.stage === 0) {
                const targetX = 260;
                const targetY = 240;
                const a = Math.atan2(targetY - player.y, targetX - player.x);
                const walkSpeed = 2.6;
                player.x += Math.cos(a) * walkSpeed;
                player.y += Math.sin(a) * walkSpeed;

                // camera follows
                camera.x = Math.max(0, Math.min(player.x - canvas.width / 2, WORLD_WIDTH - canvas.width));
                camera.y = Math.max(0, Math.min(player.y - canvas.height / 2, WORLD_HEIGHT - canvas.height));

                if (Math.hypot(player.x - targetX, player.y - targetY) < 6 || hotrodCutscene.stageT > 140) {
                    player.x = targetX;
                    player.y = targetY;
                    hotrodCutscene.stage = 1;
                    hotrodCutscene.stageT = 0;

                    // setup wide shot camera targets
                    hotrodCutscene.camFromX = camera.x;
                    hotrodCutscene.camFromY = camera.y;

                    // Wide plan: show a big part of the arena BUT keep Jack visible in frame.
                    // Put Jack more to the left/top of the screen so we see more of the arena.
                    hotrodCutscene.camToX = Math.max(0, Math.min(player.x - canvas.width * 0.18, WORLD_WIDTH - canvas.width));
                    hotrodCutscene.camToY = Math.max(0, Math.min(player.y - canvas.height * 0.22, WORLD_HEIGHT - canvas.height));
                }
                return;
            }

            // Stage 1: wide shot pan (~1.7s + hold)
            if (hotrodCutscene.stage === 1) {
                const t = Math.min(1, hotrodCutscene.stageT / 90);
                // ease
                const tt = t * t * (3 - 2 * t);
                camera.x = lerp(hotrodCutscene.camFromX, hotrodCutscene.camToX, tt);
                camera.y = lerp(hotrodCutscene.camFromY, hotrodCutscene.camToY, tt);

                if (hotrodCutscene.stageT > 120) {
                    hotrodCutscene.stage = 2;
                    hotrodCutscene.stageT = 0;
                }
                return;
            }

            // Stage 2: SHOW TIME (~1.3s)
            if (hotrodCutscene.stage === 2) {
                // keep camera in wide shot
                camera.x = hotrodCutscene.camToX;
                camera.y = hotrodCutscene.camToY;

                if (hotrodCutscene.stageT > 78) {
                    // return camera to player and start
                    endHotrodCutscene();
                }
                return;
            }
        }

        function drawHotrodCutscene() {
            // Draw the same world as normal draw(), but without gameplay HUD and crosshair
            ctx.save();
            ctx.translate(-camera.x, -camera.y);

            // Grid
            ctx.strokeStyle = (levelTheme?.grid || '#2a2a2a');
            ctx.lineWidth = 1;
            const gridSize = 60;
            const startX = Math.floor(camera.x / gridSize) * gridSize;
            const startY = Math.floor(camera.y / gridSize) * gridSize;
            for (let i = startX; i < camera.x + canvas.width; i += gridSize) { ctx.beginPath(); ctx.moveTo(i, camera.y); ctx.lineTo(i, camera.y + canvas.height); ctx.stroke(); }
            for (let i = startY; i < camera.y + canvas.height; i += gridSize) { ctx.beginPath(); ctx.moveTo(camera.x, i); ctx.lineTo(camera.x + canvas.width, i); ctx.stroke(); }

            // Walls
            walls.forEach(w => {
                ctx.fillStyle = '#25332e';
                ctx.fillRect(w.x, w.y, w.width, w.height);
                ctx.strokeStyle = '#666';
                ctx.lineWidth = 2;
                ctx.strokeRect(w.x, w.y, w.width, w.height);
            });

            // Obstacles
            obstacles.forEach(o => {
                ctx.fillStyle = o.color;
                ctx.fillRect(o.x, o.y, o.width, o.height);
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.strokeRect(o.x, o.y, o.width, o.height);

                // Match main draw look for explosive barrels
                if (o.type === 'explosive_barrel') {
                    ctx.save();
                    ctx.fillStyle = '#c40000';
                    ctx.fillRect(o.x, o.y, o.width, o.height);
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(o.x, o.y, o.width, o.height);

                    ctx.globalAlpha = 0.85;
                    ctx.fillStyle = 'rgba(255,255,255,0.22)';
                    ctx.fillRect(o.x + 4, o.y + o.height * 0.28, o.width - 8, 3);
                    ctx.fillRect(o.x + 4, o.y + o.height * 0.68, o.width - 8, 3);
                    ctx.restore();
                }
            });

            // Enemies must be visible during cutscene
            enemies.forEach(e => {
                ctx.fillStyle = e.color;
                ctx.beginPath();
                ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();

                // HP bar (simple)
                const barWidth = 40, barHeight = 6;
                const hpP = e.hp / e.maxHP;
                ctx.fillStyle = '#000';
                ctx.fillRect(e.x - barWidth/2, e.y - e.radius - 15, barWidth, barHeight);
                ctx.fillStyle = hpP > 0.6 ? '#0f0' : hpP > 0.3 ? '#ff0' : '#f00';
                ctx.fillRect(e.x - barWidth/2, e.y - e.radius - 15, barWidth * hpP, barHeight);
            });

            // Jack (player)
            ctx.save();
            ctx.translate(player.x, player.y);
            // face towards arena focus for the shot
            const a = Math.atan2((WORLD_HEIGHT * 0.45) - player.y, (WORLD_WIDTH * 0.45) - player.x);
            ctx.rotate(a);
            drawWeapon(player.radius + 5, 0, player.weapon, 1);
            ctx.restore();

            ctx.fillStyle = player.color;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.restore();

            // Stage 2: SHOW TIME appears near Jack (world-space, not screen center)
            if (hotrodCutscene.stage === 2) {
                const t = performance.now() * 0.006;
                const pulse = 1 + 0.06 * Math.sin(t);

                // Convert Jack's world position to screen space
                const sx = player.x - camera.x;
                const sy = player.y - camera.y;

                ctx.save();
                ctx.globalCompositeOperation = 'lighter';

                // main shout
                ctx.textBaseline = 'middle';
                ctx.font = `900 ${Math.floor(72 * pulse)}px Courier New`;
                ctx.fillStyle = 'rgba(255, 0, 0, 0.92)';
                ctx.shadowBlur = 22;
                ctx.shadowColor = 'rgba(255,0,0,0.95)';
                // Place text slightly above/right from Jack
                ctx.fillText('SHOW TIME', sx + 40, sy - 42);
                ctx.shadowBlur = 0;
                ctx.restore();

                // small subtitle
                ctx.save();
                ctx.globalAlpha = 0.8;
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 14px Courier New';
                ctx.textAlign = 'center';
                ctx.fillText('Нажмите E (У) чтобы пропустить', canvas.width / 2, canvas.height - 44);
                ctx.restore();
            }

            // Hint for skip on other stages
            if (hotrodCutscene.stage !== 2) {
                ctx.save();
                ctx.globalAlpha = 0.6;
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 14px Courier New';
                ctx.textAlign = 'right';
                ctx.fillText('E (У) — пропуск', canvas.width - 24, 30);
                ctx.restore();
            }
        }

        // Dual-weapon helper (alternates left/right muzzle)
        let dualSide = 1;

        function shoot() {
            if (!canShoot || gameState !== 'playing' || currentWeapon.ammo <= 0) return;

            const angle = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x);

            // ===== Flamethrower =====
            if (currentWeapon.type === 'flame') {
                const range = currentWeapon.range || 300;
                const cone = currentWeapon.cone || 0.55; // half-angle

                flameAimAngle = angle;

                // Spawn flame particles (visual)
                const muzzleDist = player.radius + 26;
                const mx = player.x + Math.cos(angle) * muzzleDist;
                const my = player.y + Math.sin(angle) * muzzleDist;

                // More particles and longer travel so the "stream" reads as medium range
                const particleCount = 16;
                for (let i = 0; i < particleCount; i++) {
                    const a = angle + (Math.random() - 0.5) * cone * 2;
                    // push further so flame reaches mid-range visually
                    const sp = 8.8 + Math.random() * 7.2;
                    const life = 18 + Math.floor(Math.random() * 16);
                    const r = 4.5 + Math.random() * 8.5;
                    flameParticles.push({
                        x: mx + (Math.random() - 0.5) * 6,
                        y: my + (Math.random() - 0.5) * 6,
                        vx: Math.cos(a) * sp,
                        vy: Math.sin(a) * sp,
                        r,
                        life,
                        maxLife: life,
                        heat: 0.7 + Math.random() * 0.9
                    });
                }

                // Keep arrays bounded (perf)
                if (flameParticles.length > 380) flameParticles.splice(0, flameParticles.length - 380);

                // Heat spots along most of the stream to convey range (visual only)
                if (Math.random() < 0.85) {
                    const distF = 0.25 + Math.random() * 0.75; // up to near max range
                    const hx = mx + Math.cos(angle) * (30 + distF * range);
                    const hy = my + Math.sin(angle) * (30 + distF * range);
                    flameHeat.push({ x: hx, y: hy, r: 18 + Math.random() * 26, life: 10 + Math.floor(Math.random() * 12), maxLife: 20 });
                    if (flameHeat.length > 90) flameHeat.splice(0, flameHeat.length - 90);
                }

                // Deal damage in a cone (≈30 HP/sec while holding)
                const applyFlameDamage = (target) => {
                    if (!target) return;
                    const dx = target.x - player.x;
                    const dy = target.y - player.y;
                    const dist = Math.hypot(dx, dy);
                    if (dist > range + target.radius) return;
                    const aTo = Math.atan2(dy, dx);
                    if (Math.abs(angleDiff(aTo, angle)) > cone) return;
                    target.hp -= currentWeapon.damage;
                };

                for (let j = enemies.length - 1; j >= 0; j--) {
                    applyFlameDamage(enemies[j]);
                    if (enemies[j].hp <= 0) {
                        enemies.splice(j, 1);
                        kills++;
                    }
                }
                if (miniBoss) {
                    applyFlameDamage(miniBoss);
                    if (miniBoss.hp <= 0) miniBossDefeated();
                    else updateMiniBossHealthBar();
                }
                if (boss) {
                    applyFlameDamage(boss);
                    if (boss.hp <= 0) bossDefeated();
                    else updateBossHealthBar();
                }

                // Tutorial: flamethrower can damage training targets
                if (currentLevel === 0 && tutorialTargets && tutorialTargets.length) {
                    for (const t of tutorialTargets) {
                        if (t.hit) continue;
                        applyFlameDamage(t);
                        if (t.hp <= 0) {
                            t.hit = true;
                            t.color = '#cc0000';
                            playSound('hit_target');
                        }
                    }
                }

                // Consume fuel not every tick (so 100 lasts longer)
                if (currentWeapon.ammo !== Infinity) {
                    currentWeapon._consumeAcc = (currentWeapon._consumeAcc || 0) + 1;
                    const every = Math.max(1, currentWeapon.consumeEvery || 3);
                    if (currentWeapon._consumeAcc >= every) {
                        currentWeapon._consumeAcc = 0;
                        currentWeapon.ammo--;
                        // Spawn fuel pickup once when we hit 0
                        if (currentWeapon.ammo <= 0 && !flameFuelSpawnedThisZero) {
                            flameFuelSpawnedThisZero = true;
                            spawnFlameFuelPickup(30);
                        }
                    }
                }

                playSound(currentWeapon.sound);
                canShoot = false;
                setTimeout(() => canShoot = true, currentWeapon.fireRate);
                updateHUD();
                return;
            }

            // ===== Melee =====
            if (currentWeapon.type === 'melee') {
                const effectiveRange = currentWeapon.range;
                enemies.forEach(e => {
                    const dist = Math.hypot(player.x - e.x, player.y - e.y);
                    const angleToEnemy = Math.atan2(e.y - player.y, e.x - player.x);
                    if (dist < player.radius + effectiveRange && Math.abs(angleToEnemy - angle) < Math.PI / 2) {
                        e.hp -= currentWeapon.damage;
                        if (e.hp <= 0) {
                            enemies.splice(enemies.indexOf(e), 1);
                            kills++;
                            updateHUD();
                        }
                    }
                });

                if (currentLevel === 0) {
                    tutorialTargets.forEach(t => {
                        const dist = Math.hypot(player.x - t.x, player.y - t.y);
                        const angleToTarget = Math.atan2(t.y - player.y, t.x - player.x);
                        if (dist < player.radius + effectiveRange && Math.abs(angleToTarget - angle) < Math.PI / 2 && !t.hit) {
                            t.hp -= currentWeapon.damage;
                            if (t.hp <= 0) {
                                t.hit = true;
                                t.color = '#cc0000';
                                playSound('hit_target');
                            }
                        }
                    });
                }

                if (abilityActive && selectedCharacter === 'machete_char') {
                    for (let i = obstacles.length - 1; i >= 0; i--) {
                        const obs = obstacles[i];
                        const obsX = obs.x + obs.width / 2;
                        const obsY = obs.y + obs.height / 2;
                        const dist = Math.hypot(player.x - obsX, player.y - obsY);
                        const angleToObs = Math.atan2(obsY - player.y, obsX - player.x);
                        if (dist < player.radius + effectiveRange + Math.max(obs.width, obs.height) / 2 && Math.abs(angleToObs - angle) < Math.PI / 2) {
                            obstacles.splice(i, 1);
                            for (let j = walls.length - 1; j >= 0; j--) {
                                if (walls[j].x === obs.x && walls[j].y === obs.y && walls[j].width === obs.width && walls[j].height === obs.height) {
                                    walls.splice(j, 1);
                                    break;
                                }
                            }
                        }
                    }
                }

                macheteSlash = { x: player.x, y: player.y, angle, radius: player.radius + effectiveRange, duration: 10 };
            } else {
                // ===== Ranged =====
                if (currentWeapon.spread) {
                    for (let i = 0; i < currentWeapon.spread; i++) {
                        bullets.push({
                            x: player.x,
                            y: player.y,
                            radius: 5,
                            speedX: Math.cos(angle + (Math.random() - 0.5) * 0.6) * currentWeapon.bulletSpeed,
                            speedY: Math.sin(angle + (Math.random() - 0.5) * 0.6) * currentWeapon.bulletSpeed,
                            damage: currentWeapon.damage,
                            color: currentWeapon.color
                        });
                    }
                } else if (currentWeapon.burst && currentWeapon.burst > 1) {
                    // Burst weapons (Skyler SMG: 3 bullets per click)
                    const shots = currentWeapon.burst;
                    const delay = currentWeapon.burstDelay || 60;
                    for (let n = 0; n < shots; n++) {
                        setTimeout(() => {
                            if (gameState !== 'playing') return;
                            // Default muzzle origin for burst
                            let bx = player.x;
                            let by = player.y;
                            bullets.push({
                                x: bx,
                                y: by,
                                radius: 5,
                                speedX: Math.cos(angle) * currentWeapon.bulletSpeed,
                                speedY: Math.sin(angle) * currentWeapon.bulletSpeed,
                                damage: currentWeapon.damage,
                                color: currentWeapon.color,
                                pierce: 0,
                                hitIds: null,
                                // помечаем пули Skyler для особого эффекта
                                fromSkyler: selectedCharacter === 'skyler'
                            });
                        }, n * delay);
                    }
                } else {
                    // Default muzzle origin
                    let originX = player.x;
                    let originY = player.y;

                    // Special: MESH dual pistols — bullets come out of alternating muzzles
                    if (currentWeapon.dual) {
                        const forward = player.radius + 16;
                        const side = 9; // distance between pistols
                        // Perpendicular vector
                        const px = -Math.sin(angle);
                        const py = Math.cos(angle);
                        originX = player.x + Math.cos(angle) * forward + px * (side * dualSide);
                        originY = player.y + Math.sin(angle) * forward + py * (side * dualSide);

                        // small muzzle flash (visual)
                        muzzleFlashes.push({ x: originX, y: originY, angle, life: 6, maxLife: 6 });
                        if (muzzleFlashes.length > 40) muzzleFlashes.splice(0, muzzleFlashes.length - 40);

                        dualSide *= -1;
                    }

                    bullets.push({
                        x: originX,
                        y: originY,
                        radius: 5,
                        speedX: Math.cos(angle) * currentWeapon.bulletSpeed,
                        speedY: Math.sin(angle) * currentWeapon.bulletSpeed,
                        damage: currentWeapon.damage,
                        color: currentWeapon.color,
                        // Sniper perk: 50% chance to pierce 2 enemies total
                        pierce: (player.weapon === 'sniper' && Math.random() < 0.5) ? 1 : 0,
                        hitIds: null
                    });
                }
            }

            if (currentWeapon.ammo !== Infinity) currentWeapon.ammo--;
            playSound(currentWeapon.sound);
            canShoot = false;
            setTimeout(() => canShoot = true, currentWeapon.fireRate);
            updateHUD();
        }

        function updateBoss() {
            if (!boss) return;
            boss.rotation += 0.02; boss.attackTimer++; boss.moveTimer++;
            boss.phase = boss.hp < boss.maxHP * 0.25 ? 4 : boss.hp < boss.maxHP * 0.5 ? 3 : boss.hp < boss.maxHP * 0.75 ? 2 : 1;
            if (boss.moveTimer > 180) { boss.targetX = 400 + Math.random() * (WORLD_WIDTH - 800); boss.targetY = 400 + Math.random() * (WORLD_HEIGHT - 800); boss.moveTimer = 0; }
            const dx = boss.targetX - boss.x, dy = boss.targetY - boss.y, dist = Math.hypot(dx, dy);
            if (dist > 10) { boss.x += (dx / dist) * boss.speed; boss.y += (dy / dist) * boss.speed; }
            const attackSpeed = boss.phase === 4 ? 40 : boss.phase === 3 ? 50 : 60;
            if (boss.attackTimer > attackSpeed) {
                boss.attackType = Math.floor(Math.random() * 5); boss.attackTimer = 0;
                const attacks = [
                    () => { const bulletCount = 8 + boss.phase * 4; for (let i = 0; i < bulletCount; i++) { const angle = (Math.PI * 2 / bulletCount) * i + boss.rotation; enemyBullets.push({ x: boss.x, y: boss.y, radius: 6, speedX: Math.cos(angle) * 5, speedY: Math.sin(angle) * 5, damage: 15, color: '#ff0000' }); } },
                    () => { const playerAngle = Math.atan2(player.y - boss.y, player.x - boss.x); for (let i = -3; i <= 3; i++) { const spreadAngle = playerAngle + i * 0.15; enemyBullets.push({ x: boss.x, y: boss.y, radius: 8, speedX: Math.cos(spreadAngle) * 9, speedY: Math.sin(spreadAngle) * 9, damage: 20, color: '#ff6600' }); } },
                    () => { for (let i = 0; i < 4; i++) { const mX = boss.x + (Math.random() - 0.5) * 400, mY = boss.y + (Math.random() - 0.5) * 400; setTimeout(() => enemyBullets.push({ x: mX, y: mY, radius: 15, speedX: 0, speedY: 0, damage: 25, color: '#ff00ff', mine: true, timer: 90 }), i * 150); } },
                    () => { for (let wave = 0; wave < 3; wave++) setTimeout(() => { for (let i = 0; i < 6; i++) { const angle = (Math.PI * 2 / 6) * i; enemyBullets.push({ x: boss.x, y: boss.y, radius: 5, speedX: Math.cos(angle) * (4 + wave), speedY: Math.sin(angle) * (4 + wave), damage: 12, color: '#00ffff' }); } }, wave * 200); },
                    () => { for (let i = 0; i < 3; i++) setTimeout(() => { const angleToPlayer = Math.atan2(player.y - boss.y, player.x - boss.x); enemyBullets.push({ x: boss.x, y: boss.y, radius: 10, speedX: Math.cos(angleToPlayer) * 7, speedY: Math.sin(angleToPlayer) * 7, damage: 30, color: '#ffff00', homing: true }); }, i * 300); }
                ];
                attacks[boss.attackType]();
            }
            for (let i = bullets.length - 1; i >= 0; i--) { const dist = Math.hypot(bullets[i].x - boss.x, bullets[i].y - boss.y); if (dist < bullets[i].radius + boss.radius) { boss.hp -= bullets[i].damage; bullets.splice(i, 1); updateBossHealthBar(); if (boss.hp <= 0) bossDefeated(); } }
        }

        function updateBossHealthBar() { if (!boss) return; document.getElementById('bossHealthFill').style.width = Math.max(0, boss.hp / boss.maxHP) * 100 + '%'; }
        function bossDefeated() {
            // In HARD-MODE the boss is the final step: finish the run properly.
            if (hardMode) {
                // Force progress to the last stage so hard-mode completion triggers.
                hardModeProgress = Math.max(hardModeProgress, 5);
                levelComplete();
                return;
            }

            gameState = 'complete';
            stopMusic();
            stopAllHtmlMusic(true);
            setTimeout(() => {
                showGameAlert('🎉 BIG-BOB ПОБЕЖДЕН!\n\nВы спасли мир от этого монстра!\n\nОтличная работа!', 'Победа над боссом').then(() => backToMainMenuFromGame());
            }, 100);
        }

        function update() {
            if (gameState !== 'playing' && gameState !== 'cutscene') return;
            // Cutscene: HoTRoD intro
            if (hotrodCutscene.active) {
                updateHotrodCutscene();
                return;
            }
            if (gameState !== 'playing') return;

            if (currentLevel === 0) {
                updateTutorial();
            }
            updateAbility();
            updateAmbient();
            updateFlame();
            updateMeshGrenades();

            // Skyler dash update
            if (selectedCharacter === 'skyler') {
                if (skylerDash.cooldown > 0) skylerDash.cooldown--;

                const insideSkywardWalkZone = (x, y) => {
                    for (const z of skywardWalkZones) {
                        if (x >= z.x + player.radius && x <= z.x + z.w - player.radius && y >= z.y + player.radius && y <= z.y + z.h - player.radius) return true;
                    }
                    return false;
                };

                if (skylerDash.active) {
                    // Dash can cross gaps on Skyward Ascent.
                    // We still prevent clipping into obstacles/walls.
                    const stepX = player.x + skylerDash.vx;
                    const stepY = player.y + skylerDash.vy;

                    if (currentLevel === 102) {
                        // allow crossing gaps (no walk-zone restriction)
                        if (!checkWallCollision(stepX, player.y, player.radius)) player.x = stepX;
                        if (!checkWallCollision(player.x, stepY, player.radius)) player.y = stepY;
                    } else {
                        if (!checkWallCollision(stepX, player.y, player.radius)) player.x = stepX;
                        if (!checkWallCollision(player.x, stepY, player.radius)) player.y = stepY;
                        player.x = Math.max(player.radius, Math.min(WORLD_WIDTH - player.radius, player.x));
                        player.y = Math.max(player.radius, Math.min(WORLD_HEIGHT - player.radius, player.y));
                    }

                    skylerDash.t--;
                    if (skylerDash.t <= 0) {
                        skylerDash.active = false;
                        // If dash ended outside rooftops, snap back to last safe roof position
                        if (currentLevel === 102 && !insideSkywardWalkZone(player.x, player.y)) {
                            player.x = skywardLastSafe.x;
                            player.y = skywardLastSafe.y;
                        }
                    }
                }

                // Отдельный таймер неуязвимости (может быть дольше самого рывка)
                if (skylerDash.invulnT > 0) {
                    skylerDash.invulnT--;
                }

                // Ability status text (simple)
                if (!skylerDash.active) {
                    const ab = document.getElementById('abilityStatus');
                    const tx = document.getElementById('abilityText');
                    if (ab && tx && gameState === 'playing') {
                        ab.style.display = 'block';
                        if (skylerDash.cooldown > 0) {
                            tx.textContent = 'Перезарядка...';
                            tx.style.color = '#ff4444';
                        } else {
                            tx.textContent = 'Готова (ПКМ)';
                            tx.style.color = '#00ff00';
                        }
                    }
                }
            }

            // HoTRoD grenade pickups spawning
            if (currentLevel === 101) {
                grenadeSpawnTimer++;
                if (grenadeSpawnTimer >= HOTROD_GRENADE_SPAWN_EVERY) {
                    grenadeSpawnTimer = 0;
                    // keep count reasonable
                    if (grenadePickups.length < 7) {
                        const pos = getRandomFreePosition();
                        createGrenadePickup(pos.x, pos.y, 1);
                    }
                }

            }

            // Explosion visuals update
            if (screenFlash > 0) screenFlash = Math.max(0, screenFlash - 0.07);
            if (shockwaves.length) {
                for (let i = shockwaves.length - 1; i >= 0; i--) {
                    const s = shockwaves[i];
                    s.r += s.vr;
                    s.vr *= 0.92;
                    s.life--;
                    if (s.life <= 0) shockwaves.splice(i, 1);
                }
            }
            if (scorchMarks.length) {
                for (let i = scorchMarks.length - 1; i >= 0; i--) {
                    scorchMarks[i].life--;
                    if (scorchMarks[i].life <= 0) scorchMarks.splice(i, 1);
                }
            }

            // Update muzzle flashes (visual only)
            if (muzzleFlashes.length) {
                for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
                    muzzleFlashes[i].life--;
                    if (muzzleFlashes[i].life <= 0) muzzleFlashes.splice(i, 1);
                }
            }

            // Pyro ability effects (damage + ammo regen)
            if (selectedCharacter === 'pyro' && pyroAura.active) {
                pyroAura.t += 1;

                // Spawn a few ring sparks (visual only, lightweight)
                if (pyroAura.t % 3 === 0) {
                    const base = Math.random() * Math.PI * 2;
                    for (let k = 0; k < 2; k++) {
                        const a = base + (k ? 0.18 : -0.18);
                        const rr = pyroAura.radius + 6 + Math.random() * 10;
                        const x = player.x + Math.cos(a) * rr;
                        const y = player.y + Math.sin(a) * rr;
                        const sp = 2.0 + Math.random() * 2.6;
                        const life = 14 + Math.floor(Math.random() * 10);
                        flameParticles.push({
                            x,
                            y,
                            vx: Math.cos(a) * sp + (Math.random() - 0.5) * 1.2,
                            vy: Math.sin(a) * sp + (Math.random() - 0.5) * 1.2,
                            r: 3.0 + Math.random() * 4.0,
                            life,
                            maxLife: life,
                            heat: 0.9 + Math.random() * 0.6
                        });
                    }
                    if (flameParticles.length > 380) flameParticles.splice(0, flameParticles.length - 380);
                }
                // damage enemies inside circle (continuous)
                const dmg = pyroAura.dps / 60;
                for (let i = enemies.length - 1; i >= 0; i--) {
                    const e = enemies[i];
                    if (Math.hypot(e.x - player.x, e.y - player.y) <= pyroAura.radius + e.radius) {
                        e.hp -= dmg;
                        if (e.hp <= 0) {
                            enemies.splice(i, 1);
                            kills++;
                        }
                    }
                }
                if (miniBoss && Math.hypot(miniBoss.x - player.x, miniBoss.y - player.y) <= pyroAura.radius + miniBoss.radius) {
                    miniBoss.hp -= dmg;
                    if (miniBoss.hp <= 0) miniBossDefeated();
                    else updateMiniBossHealthBar();
                }
                if (boss && Math.hypot(boss.x - player.x, boss.y - player.y) <= pyroAura.radius + boss.radius) {
                    boss.hp -= dmg;
                    if (boss.hp <= 0) bossDefeated();
                    else updateBossHealthBar();
                }

                // fuel regen every second while aura is active
                pyroAura.tickAcc += 1 / 60;
                if (pyroAura.tickAcc >= 1) {
                    pyroAura.tickAcc = 0;
                    const st = playerWeaponsState['flamethrower'] || (player.weapon === 'flamethrower' ? currentWeapon : null);
                    if (st && st.ammo !== Infinity) {
                        st.ammo = Math.min(100, (st.ammo || 0) + pyroAura.ammoPerSec);
                        playerWeaponsState['flamethrower'] = { ...st };
                        if (player.weapon === 'flamethrower') currentWeapon.ammo = st.ammo;
                        // if we were at 0, allow next pickup spawn later
                        if (st.ammo > 0) flameFuelSpawnedThisZero = false;
                        updateHUD();
                    }
                }
            }

            let newX = player.x, newY = player.y;
            if (keys['w']) newY -= player.speed; if (keys['s']) newY += player.speed; if (keys['a']) newX -= player.speed; if (keys['d']) newX += player.speed;

            // Skyward Ascent: allow WALKING only on rooftops + planks.
            // Dash can cross gaps.
            const insideSkywardWalkZone = (x, y) => {
                for (const z of skywardWalkZones) {
                    if (x >= z.x + player.radius && x <= z.x + z.w - player.radius && y >= z.y + player.radius && y <= z.y + z.h - player.radius) return true;
                }
                return false;
            };

            if (currentLevel === 102) {
                // Store last safe position (used to snap back if dash ends in the void)
                if (!skylerDash.active && insideSkywardWalkZone(player.x, player.y)) {
                    skywardLastSafe.x = player.x;
                    skywardLastSafe.y = player.y;
                }

                // Apply axis movement only if it stays in a walk zone
                if (!skylerDash.active) {
                    if (!checkWallCollision(newX, player.y, player.radius) && insideSkywardWalkZone(newX, player.y)) player.x = newX;
                    if (!checkWallCollision(player.x, newY, player.radius) && insideSkywardWalkZone(player.x, newY)) player.y = newY;
                }
            } else {
                if (!checkWallCollision(newX, player.y, player.radius)) player.x = newX;
                if (!checkWallCollision(player.x, newY, player.radius)) player.y = newY;
                player.x = Math.max(player.radius, Math.min(WORLD_WIDTH - player.radius, player.x));
                player.y = Math.max(player.radius, Math.min(WORLD_HEIGHT - player.radius, player.y));
            }
            camera.x = Math.max(0, Math.min(player.x - canvas.width / 2, WORLD_WIDTH - canvas.width));
            camera.y = Math.max(0, Math.min(player.y - canvas.height / 2, WORLD_HEIGHT - canvas.height));

            if (camera.shakeDuration > 0) {
                const p = camera.shakePower || 10;
                camera.shakeX = (Math.random() - 0.5) * p;
                camera.shakeY = (Math.random() - 0.5) * p;
                camera.shakeDuration--;
                // ease out power slightly
                camera.shakePower = Math.max(6, p * 0.96);
            } else {
                camera.shakeX = 0;
                camera.shakeY = 0;
                camera.shakePower = 10;
            }

            const hpPercent = (player.hp / player.maxHP) * 100;
            const threshold = Math.floor(hpPercent / 20) * 20;
            if (threshold < player.lastHpThreshold) {
                camera.shakeDuration = 15;
                player.lastHpThreshold = threshold;
            }

            if (mouse.clicked) shoot();
            if (macheteSlash) { macheteSlash.duration--; if (macheteSlash.duration <= 0) macheteSlash = null; }
            if (boss) { updateBoss(); weaponSpawnTimer++; if (weaponSpawnTimer > 300) { spawnBossWeapon(); weaponSpawnTimer = 0; } }

            for (let i = bullets.length - 1; i >= 0; i--) {
                const b = bullets[i];
                b.x += b.speedX; b.y += b.speedY;

                // Hit explosive barrels (HoTRoD)
                let barrelHit = false;
                for (let k = obstacles.length - 1; k >= 0; k--) {
                    const o = obstacles[k];
                    if (o.type !== 'explosive_barrel') continue;
                    const cx = o.x + o.width / 2;
                    const cy = o.y + o.height / 2;
                    if (Math.hypot(b.x - cx, b.y - cy) < b.radius + Math.max(o.width, o.height) / 2) {
                        o.hits = (o.hits || 0) + 1;
                        barrelHit = true;

                        // remove the bullet on hit (no piercing into barrels)
                        bullets.splice(i, 1);

                        if (o.hits >= (o.hitsToExplode || 3)) {
                            explodeBarrel(o);
                        }
                        break;
                    }
                }
                if (barrelHit) continue;

                // Out of bounds or wall collision
                if (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT || checkWallCollision(b.x, b.y, b.radius)) { bullets.splice(i, 1); continue; }

                // Hit enemies (sniper can pierce)
                for (let j = enemies.length - 1; j >= 0; j--) {
                    const e = enemies[j];
                    const dist = Math.hypot(b.x - e.x, b.y - e.y);
                    if (dist < b.radius + e.radius) {
                        // prevent double-hit same enemy on same bullet
                        if (b.hitIds) {
                            if (b.hitIds.has(e.id)) continue;
                        } else {
                            b.hitIds = new Set();
                        }
                        b.hitIds.add(e.id);

                        e.hp -= b.damage;

                        if (e.hp <= 0) {
                            enemies.splice(j, 1);
                            kills++;
                            updateHUD();
                        }

                        if (b.pierce && b.pierce > 0) {
                            b.pierce--;
                            // keep flying
                        } else {
                            bullets.splice(i, 1);
                        }
                        break;
                    }
                }
            }

            for (let i = enemies.length - 1; i >= 0; i--) {
                const e = enemies[i], dist = Math.hypot(player.x - e.x, player.y - e.y);
                if (e.pathfindTimer++ > 10) { findPath(e); e.pathfindTimer = 0; }
                if (e.isTutorialEnemy && tutorialStage < 4) e.speed = 0;
                else if (e.isTutorialEnemy && tutorialStage >= 4) e.speed = (3.5 + currentLevel * 0.4) * 2;
                const angleToTarget = Math.atan2(e.targetY - e.y, e.targetX - e.x);
                if (e.type === 'melee' || e.type === 'tank' || e.type === 'ambush') {
                    let newX = e.x + Math.cos(angleToTarget) * e.speed;
                    let newY = e.y + Math.sin(angleToTarget) * e.speed;
                    if (currentLevel === 102 && e.home) {
                        newX = Math.min(e.home.maxX - e.radius, Math.max(e.home.minX + e.radius, newX));
                        newY = Math.min(e.home.maxY - e.radius, Math.max(e.home.minY + e.radius, newY));
                    }
                    if (!checkWallCollision(newX, newY, e.radius)) { e.x = newX; e.y = newY; }
                    if (dist < player.radius + e.radius && !(abilityActive && selectedCharacter === 'tank') && !(selectedCharacter === 'skyler' && skylerDash.active)) { player.hp -= e.damage; updateHUD(); }
                } else if (e.type === 'miniganer') {
                    // Miniganer: medium unit, does NOT hide behind walls,
                    // but only shoots when it has line of sight to the player.
                    // Movement: tries to keep medium distance and repositions slightly.

                    const aToPlayer = Math.atan2(player.y - e.y, player.x - e.x);
                    const optimal = 360;

                    // Move to keep distance (no cover logic)
                    if (dist > optimal + 80) {
                        let newX = e.x + Math.cos(aToPlayer) * e.speed;
                        let newY = e.y + Math.sin(aToPlayer) * e.speed;
                        if (currentLevel === 102 && e.home) {
                            newX = Math.min(e.home.maxX - e.radius, Math.max(e.home.minX + e.radius, newX));
                            newY = Math.min(e.home.maxY - e.radius, Math.max(e.home.minY + e.radius, newY));
                        }
                        if (!checkWallCollision(newX, newY, e.radius)) { e.x = newX; e.y = newY; }
                    } else if (dist < optimal - 70) {
                        let newX = e.x - Math.cos(aToPlayer) * e.speed;
                        let newY = e.y - Math.sin(aToPlayer) * e.speed;
                        if (currentLevel === 102 && e.home) {
                            newX = Math.min(e.home.maxX - e.radius, Math.max(e.home.minX + e.radius, newX));
                            newY = Math.min(e.home.maxY - e.radius, Math.max(e.home.minY + e.radius, newY));
                        }
                        if (!checkWallCollision(newX, newY, e.radius)) { e.x = newX; e.y = newY; }
                    } else {
                        // slight strafe to avoid being static
                        const strafe = (e.id % 2 === 0) ? 1 : -1;
                        let sx = e.x + Math.cos(aToPlayer + Math.PI / 2) * (e.speed * 0.55 * strafe);
                        let sy = e.y + Math.sin(aToPlayer + Math.PI / 2) * (e.speed * 0.55 * strafe);
                        if (currentLevel === 102 && e.home) {
                            sx = Math.min(e.home.maxX - e.radius, Math.max(e.home.minX + e.radius, sx));
                            sy = Math.min(e.home.maxY - e.radius, Math.max(e.home.minY + e.radius, sy));
                        }
                        if (!checkWallCollision(sx, sy, e.radius)) { e.x = sx; e.y = sy; }
                    }

                    const now = Date.now();
                    const canSee = (dist < e.range) && hasLineOfSight(e.x, e.y, player.x, player.y);
                    if (canSee && (now - e.lastShot > e.shootInterval)) {
                        // Machinegun: constant-ish stream, slightly chaotic
                        const cone = e.cone || 0.38;
                        const base = aToPlayer;
                        const bulletSpeed = 7;
                        const bulletsPerTick = 2;

                        for (let k = 0; k < bulletsPerTick; k++) {
                            // chaotically jitter around aim (like a minigun)
                            const off = (Math.random() - 0.5) * cone;
                            const micro = (Math.random() - 0.5) * 0.08;
                            const a = base + off + micro;
                            enemyBullets.push({
                                x: e.x,
                                y: e.y,
                                radius: 4,
                                speedX: Math.cos(a) * bulletSpeed,
                                speedY: Math.sin(a) * bulletSpeed,
                                damage: 5,
                                color: '#c0c0c0'
                            });
                        }
                        e.lastShot = now;
                    }
                } else if (e.type === 'gunnest') {
                    // Gunnest: stationary turret-like enemy.
                    // Fires like a minigun with higher RPM, but reloads every ~10 seconds.
                    // Only fires if it has line of sight.

                    const aToPlayer = Math.atan2(player.y - e.y, player.x - e.x);
                    const now = Date.now();
                    const canSee = (dist < e.range) && hasLineOfSight(e.x, e.y, player.x, player.y);

                    // Reload cycle
                    if (e.gunReloadT > 0) {
                        e.gunReloadT--;
                    } else {
                        e.gunActiveT++;
                        // 10 seconds firing then 1.5s reload pause
                        if (e.gunActiveT >= 600) {
                            e.gunActiveT = 0;
                            e.gunReloadT = 90;
                        }
                    }

                    if (canSee && e.gunReloadT <= 0 && (now - e.lastShot > e.shootInterval)) {
                        const cone = e.cone || 0.55;
                        const base = aToPlayer;
                        const bulletSpeed = 8;
                        const bulletsPerTick = 3;

                        for (let k = 0; k < bulletsPerTick; k++) {
                            const off = (Math.random() - 0.5) * cone;
                            const micro = (Math.random() - 0.5) * 0.10;
                            const a = base + off + micro;
                            enemyBullets.push({
                                x: e.x,
                                y: e.y,
                                radius: 4,
                                speedX: Math.cos(a) * bulletSpeed,
                                speedY: Math.sin(a) * bulletSpeed,
                                damage: 5,
                                color: '#bdbdbd'
                            });
                        }
                        e.lastShot = now;
                    }
                } else if (e.type === 'ranged' || e.type === 'sniper') {
                    const optimalDistance = e.type === 'sniper' ? 500 : 250;
                    if (!e.retreatMode && dist > optimalDistance + 50) {
                        let newX = e.x + Math.cos(angleToTarget) * e.speed;
                        let newY = e.y + Math.sin(angleToTarget) * e.speed;
                        if (currentLevel === 102 && e.home) {
                            newX = Math.min(e.home.maxX - e.radius, Math.max(e.home.minX + e.radius, newX));
                            newY = Math.min(e.home.maxY - e.radius, Math.max(e.home.minY + e.radius, newY));
                        }
                        if (!checkWallCollision(newX, newY, e.radius)) { e.x = newX; e.y = newY; }
                    }
                    else if (e.retreatMode || dist < optimalDistance - 50) {
                        let newX = e.x - Math.cos(angleToTarget) * e.speed;
                        let newY = e.y - Math.sin(angleToTarget) * e.speed;
                        if (currentLevel === 102 && e.home) {
                            newX = Math.min(e.home.maxX - e.radius, Math.max(e.home.minX + e.radius, newX));
                            newY = Math.min(e.home.maxY - e.radius, Math.max(e.home.minY + e.radius, newY));
                        }
                        if (!checkWallCollision(newX, newY, e.radius)) { e.x = newX; e.y = newY; }
                    }
                    const now = Date.now();
                    if (now - e.lastShot > e.shootInterval && dist < e.range && hasLineOfSight(e.x, e.y, player.x, player.y)) {
                        const angleToPlayer = Math.atan2(player.y - e.y, player.x - e.x);

                        if (e.type === 'sniper') {
                            // Sniper: high-speed bullet that can bounce up to 2 times
                            const bulletSpeed = 12;
                            enemyBullets.push({
                                x: e.x,
                                y: e.y,
                                radius: 6,
                                speedX: Math.cos(angleToPlayer) * bulletSpeed,
                                speedY: Math.sin(angleToPlayer) * bulletSpeed,
                                damage: 20,
                                color: '#ff00ff',
                                bounces: 2
                            });
                        } else {
                            // Ranged: "ability" – 2-3 projectiles in different directions (fan spread)
                            const bulletSpeed = 6;
                            const count = Math.random() < 0.55 ? 2 : 3;
                            const spread = 0.22;
                            const center = angleToPlayer + (Math.random() - 0.5) * 0.06;

                            for (let k = 0; k < count; k++) {
                                const off = (k - (count - 1) / 2) * spread;
                                const a = center + off;
                                enemyBullets.push({
                                    x: e.x,
                                    y: e.y,
                                    radius: 4,
                                    speedX: Math.cos(a) * bulletSpeed,
                                    speedY: Math.sin(a) * bulletSpeed,
                                    damage: 12,
                                    color: '#ff0000'
                                });
                            }
                        }

                        e.lastShot = now;
                    }
                }
            }

            for (let i = enemyBullets.length - 1; i >= 0; i--) {
                const b = enemyBullets[i];
                if (b.mine) { b.timer--; if (b.timer <= 0) { for (let j = 0; j < 8; j++) { const angle = (Math.PI * 2 / 8) * j; enemyBullets.push({ x: b.x, y: b.y, radius: 4, speedX: Math.cos(angle) * 6, speedY: Math.sin(angle) * 6, damage: 10, color: '#ff00ff' }); } enemyBullets.splice(i, 1); continue; } }
                else {
                    if (b.homing) { const angleToPlayer = Math.atan2(player.y - b.y, player.x - b.x); b.speedX += Math.cos(angleToPlayer) * 0.15; b.speedY += Math.sin(angleToPlayer) * 0.15; const speed = Math.hypot(b.speedX, b.speedY); if (speed > 8) { b.speedX = (b.speedX / speed) * 8; b.speedY = (b.speedY / speed) * 8; } }
                    b.x += b.speedX; b.y += b.speedY;
                    if (b.destroyObstacles) for (let j = obstacles.length - 1; j >= 0; j--) { const obs = obstacles[j], obsX = obs.x + obs.width / 2, obsY = obs.y + obs.height / 2; if (Math.hypot(b.x - obsX, b.y - obsY) < b.radius + Math.max(obs.width, obs.height) / 2) { obstacles.splice(j, 1); for (let k = walls.length - 1; k >= 0; k--) if (walls[k].x === obs.x && walls[k].y === obs.y) { walls.splice(k, 1); break; } } }
                }
                if (b.bounces !== undefined && b.bounces > 0 && checkWallCollision(b.x, b.y, b.radius)) { b.bounces--; if (b.x <= b.radius || b.x >= WORLD_WIDTH - b.radius) b.speedX *= -1; if (b.y <= b.radius || b.y >= WORLD_HEIGHT - b.radius) b.speedY *= -1; let hitWall = false; for (let w of walls) { const closestX = Math.max(w.x, Math.min(b.x, w.x + w.width)), closestY = Math.max(w.y, Math.min(b.y, w.y + w.height)); if (Math.hypot(b.x - closestX, b.y - closestY) < b.radius) { const nx = b.x - closestX, ny = b.y - closestY, len = Math.hypot(nx, ny); if (len > 0) { const nxNorm = nx / len, nyNorm = ny / len, dot = b.speedX * nxNorm + b.speedY * nyNorm; b.speedX -= 2 * dot * nxNorm; b.speedY -= 2 * dot * nyNorm; } hitWall = true; break; } } if (!hitWall && (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT)) { enemyBullets.splice(i, 1); continue; } } else if (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT || checkWallCollision(b.x, b.y, b.radius)) { enemyBullets.splice(i, 1); continue; }
                if (Math.hypot(b.x - player.x, b.y - player.y) < b.radius + player.radius) {
                    // Tank shield OR Skyler dash grant full damage immunity
                    if (!(abilityActive && selectedCharacter === 'tank') && !(selectedCharacter === 'skyler' && skylerDash.invulnT > 0)) {
                        player.hp -= b.damage;
                        updateHUD();
                    }
                    enemyBullets.splice(i, 1);
                }
            }

            if (currentLevel === 4 && enemies.length === 0 && !miniBoss && !mainEnemiesDefeated) {
                mainEnemiesDefeated = true;
                createMiniBoss();
                // Keep current HTML track (HQ) playing; do not start synth music overlays
            }
            if (miniBoss) updateMiniBoss();

            // HoTRoD: ensure final wave spawns BEFORE the level can end
            if (currentLevel === 101 && !hotrodFinalWaveSpawned && enemies.length === 0 && kills >= 20) {
                hotrodFinalWaveSpawned = true;
                spawnHotrodFinalWaveMiniganers(5);
                camera.shakeDuration = Math.max(camera.shakeDuration || 0, 18);
                camera.shakePower = Math.max(camera.shakePower || 10, 14);
            }

            if (player.hp <= 0) gameOver();

            // Level complete logic:
            // - HoTRoD (101) ends only after the final miniganer wave is spawned AND cleared
            // - Skyward Ascent (102) is WIP right now (no auto-complete yet)
            // - Other levels end when all enemies are cleared
            if (currentLevel !== 0 && enemies.length === 0 && !boss && !miniBoss) {
                if (currentLevel === 101) {
                    if (hotrodFinalWaveSpawned) levelComplete();
                } else if (currentLevel === 102) {
                    // no auto-complete (content will be added later)
                } else {
                    levelComplete();
                }
            }
        }

        function checkWallCollision(x, y, radius) {
            const r2 = radius * radius;
            for (let w of walls) {
                const closestX = Math.max(w.x, Math.min(x, w.x + w.width));
                const closestY = Math.max(w.y, Math.min(y, w.y + w.height));
                const dx = x - closestX;
                const dy = y - closestY;
                if ((dx * dx + dy * dy) < r2) return true;
            }
            return false;
        }

        function drawWeapon(x, y, type, scale = 1) {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(0.6 * scale, 0.6 * scale);

            // Subtle depth (no neon glow, more "realistic" silhouettes)
            ctx.shadowBlur = 6;
            ctx.shadowColor = 'rgba(0,0,0,0.35)';

            const metal = (x0, y0, x1, y1) => {
                const g = ctx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, '#0f1215');
                g.addColorStop(0.25, '#2a2f36');
                g.addColorStop(0.55, '#4b5560');
                g.addColorStop(0.8, '#22272e');
                g.addColorStop(1, '#0b0d10');
                return g;
            };
            const parker = (x0, y0, x1, y1) => {
                const g = ctx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, '#0d0f12');
                g.addColorStop(0.45, '#1a1f26');
                g.addColorStop(1, '#060709');
                return g;
            };
            const wood = (x0, y0, x1, y1) => {
                const g = ctx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, '#6b3f1f');
                g.addColorStop(0.5, '#8b552b');
                g.addColorStop(1, '#4e2d16');
                return g;
            };

            const strokeSoft = () => {
                ctx.lineWidth = 1.4;
                ctx.strokeStyle = 'rgba(255,255,255,0.14)';
                ctx.stroke();
                ctx.lineWidth = 2;
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.stroke();
            };

            const shapes = {
                pistol: () => {
                    // Slide
                    ctx.fillStyle = metal(-22, -10, 26, 10);
                    ctx.beginPath();
                    ctx.roundRect(-18, -7, 36, 14, 4);
                    ctx.fill();
                    strokeSoft();

                    // Barrel/muzzle
                    ctx.fillStyle = parker(18, -6, 38, 6);
                    ctx.beginPath();
                    ctx.roundRect(16, -4, 14, 8, 3);
                    ctx.fill();
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.arc(30, 0, 2.4, 0, Math.PI * 2);
                    ctx.fill();

                    // Frame
                    ctx.fillStyle = parker(-20, -10, 22, 12);
                    ctx.beginPath();
                    ctx.roundRect(-16, -2, 30, 10, 3);
                    ctx.fill();
                    strokeSoft();

                    // Trigger guard
                    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.roundRect(-2, 2, 10, 8, 4);
                    ctx.stroke();

                    // Grip
                    ctx.save();
                    ctx.translate(-6, 7);
                    ctx.rotate(0.28);
                    ctx.fillStyle = '#15181d';
                    ctx.beginPath();
                    ctx.roundRect(-8, 0, 14, 18, 4);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.stroke();
                    // grip texture
                    ctx.globalAlpha = 0.18;
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 1;
                    for (let i = 2; i < 16; i += 3) {
                        ctx.beginPath();
                        ctx.moveTo(-7, i);
                        ctx.lineTo(5, i - 2);
                        ctx.stroke();
                    }
                    ctx.restore();

                    // Rear sight
                    ctx.fillStyle = '#0a0a0a';
                    ctx.fillRect(-16, -10, 6, 4);
                    // Ejection port highlight
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#cbd5e1';
                    ctx.fillRect(0, -5, 9, 2);
                    ctx.globalAlpha = 1;
                },

                shotgun: () => {
                    // Barrel
                    ctx.fillStyle = metal(-40, -8, 60, 8);
                    ctx.beginPath();
                    ctx.roundRect(-26, -4, 66, 8, 3);
                    ctx.fill();
                    strokeSoft();

                    // Muzzle cap
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.roundRect(40, -3, 10, 6, 3);
                    ctx.fill();

                    // Receiver
                    ctx.fillStyle = parker(-20, -10, 24, 10);
                    ctx.beginPath();
                    ctx.roundRect(-18, -7, 26, 14, 4);
                    ctx.fill();
                    strokeSoft();

                    // Pump/handguard
                    ctx.fillStyle = '#2b2b2b';
                    ctx.beginPath();
                    ctx.roundRect(0, -6, 20, 12, 4);
                    ctx.fill();
                    ctx.globalAlpha = 0.20;
                    ctx.fillStyle = '#fff';
                    for (let i = 2; i < 18; i += 4) ctx.fillRect(i, -5, 1, 10);
                    ctx.globalAlpha = 1;

                    // Trigger guard
                    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.roundRect(-6, 1, 10, 8, 4);
                    ctx.stroke();

                    // Stock (wood)
                    ctx.fillStyle = wood(-60, -20, -10, 20);
                    ctx.beginPath();
                    ctx.moveTo(-18, -6);
                    ctx.lineTo(-44, -18);
                    ctx.lineTo(-56, -10);
                    ctx.lineTo(-56, 10);
                    ctx.lineTo(-44, 18);
                    ctx.lineTo(-18, 6);
                    ctx.closePath();
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();
                },

                rifle: () => {
                    // Barrel + handguard
                    ctx.fillStyle = metal(-48, -10, 72, 10);
                    ctx.beginPath();
                    ctx.roundRect(-28, -3, 82, 6, 3);
                    ctx.fill();
                    strokeSoft();

                    // Gas block / front sight
                    ctx.fillStyle = '#101214';
                    ctx.beginPath();
                    ctx.roundRect(35, -7, 8, 14, 2);
                    ctx.fill();

                    // Receiver
                    ctx.fillStyle = parker(-22, -12, 30, 12);
                    ctx.beginPath();
                    ctx.roundRect(-18, -7, 30, 14, 4);
                    ctx.fill();
                    strokeSoft();

                    // Top rail
                    ctx.globalAlpha = 0.35;
                    ctx.fillStyle = '#cbd5e1';
                    ctx.fillRect(-10, -9, 26, 2);
                    ctx.globalAlpha = 1;

                    // Magazine
                    ctx.save();
                    ctx.translate(4, 6);
                    ctx.rotate(0.10);
                    ctx.fillStyle = '#121418';
                    ctx.beginPath();
                    ctx.roundRect(-3, 0, 9, 16, 3);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.stroke();
                    ctx.restore();

                    // Grip
                    ctx.save();
                    ctx.translate(-2, 5);
                    ctx.rotate(0.35);
                    ctx.fillStyle = '#15181d';
                    ctx.beginPath();
                    ctx.roundRect(-6, 0, 10, 14, 3);
                    ctx.fill();
                    ctx.restore();

                    // Stock
                    ctx.fillStyle = '#1a1d22';
                    ctx.beginPath();
                    ctx.roundRect(-40, -6, 22, 12, 4);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();
                },

                smg: () => {
                    // Barrel
                    ctx.fillStyle = metal(-22, -10, 70, 10);
                    ctx.beginPath();
                    ctx.roundRect(20, -3, 28, 6, 3);
                    ctx.fill();

                    // Receiver
                    ctx.fillStyle = parker(-32, -14, 34, 14);
                    ctx.beginPath();
                    ctx.roundRect(-18, -8, 40, 16, 4);
                    ctx.fill();
                    strokeSoft();

                    // Ejection/upper highlight
                    ctx.globalAlpha = 0.18;
                    ctx.fillStyle = '#e5e7eb';
                    ctx.fillRect(-8, -6, 22, 2);
                    ctx.globalAlpha = 1;

                    // Magazine (straight)
                    ctx.fillStyle = '#121418';
                    ctx.beginPath();
                    ctx.roundRect(-2, 6, 8, 18, 2);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.stroke();

                    // Grip
                    ctx.save();
                    ctx.translate(8, 6);
                    ctx.rotate(0.40);
                    ctx.fillStyle = '#15181d';
                    ctx.beginPath();
                    ctx.roundRect(-6, 0, 10, 14, 3);
                    ctx.fill();
                    ctx.restore();

                    // Stock (simple)
                    ctx.fillStyle = '#111317';
                    ctx.beginPath();
                    ctx.roundRect(-34, -4, 16, 8, 3);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.roundRect(-44, -2, 12, 4, 2);
                    ctx.fill();
                },

                // Skyler SMG (burst) — визуально как ПП с фиолетовыми акцентами
                skyler_burst: () => {
                    // Barrel
                    ctx.fillStyle = metal(-22, -10, 70, 10);
                    ctx.beginPath();
                    ctx.roundRect(20, -3, 30, 6, 3);
                    ctx.fill();

                    // Receiver с фиолетовым оттенком
                    const bodyGrad = ctx.createLinearGradient(-18, -8, 22, 8);
                    bodyGrad.addColorStop(0, '#2b153f');
                    bodyGrad.addColorStop(0.5, '#4c1d95');
                    bodyGrad.addColorStop(1, '#111827');
                    ctx.fillStyle = bodyGrad;
                    ctx.beginPath();
                    ctx.roundRect(-18, -8, 40, 16, 4);
                    ctx.fill();
                    strokeSoft();

                    // Верхний свет
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#e9d5ff';
                    ctx.fillRect(-10, -7, 26, 3);
                    ctx.globalAlpha = 1;

                    // Магазин (чуть изогнутый)
                    ctx.save();
                    ctx.translate(0, 8);
                    ctx.rotate(0.22);
                    ctx.fillStyle = '#111827';
                    ctx.beginPath();
                    ctx.roundRect(-3, 0, 9, 20, 3);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(15,23,42,0.8)';
                    ctx.stroke();
                    ctx.restore();

                    // Рукоять
                    ctx.save();
                    ctx.translate(9, 6);
                    ctx.rotate(0.40);
                    ctx.fillStyle = '#1f2937';
                    ctx.beginPath();
                    ctx.roundRect(-6, 0, 11, 15, 3);
                    ctx.fill();
                    // небольшие пиксельные засечки
                    ctx.globalAlpha = 0.4;
                    ctx.fillStyle = '#a855f7';
                    ctx.fillRect(-4, 2, 2, 2);
                    ctx.fillRect(-1, 6, 2, 2);
                    ctx.globalAlpha = 1;
                    ctx.restore();

                    // Приклад
                    ctx.fillStyle = '#0f172a';
                    ctx.beginPath();
                    ctx.roundRect(-40, -4, 18, 8, 3);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.roundRect(-50, -2, 12, 4, 2);
                    ctx.fill();
                },

                sniper: () => {
                    // Barrel
                    ctx.fillStyle = metal(-60, -10, 100, 10);
                    ctx.beginPath();
                    ctx.roundRect(-30, -2, 90, 4, 2);
                    ctx.fill();
                    strokeSoft();

                    // Muzzle brake
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.roundRect(60, -3, 10, 6, 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.35;
                    ctx.fillStyle = '#cbd5e1';
                    ctx.fillRect(62, -2, 2, 4);
                    ctx.fillRect(66, -2, 2, 4);
                    ctx.globalAlpha = 1;

                    // Receiver
                    ctx.fillStyle = parker(-26, -14, 34, 14);
                    ctx.beginPath();
                    ctx.roundRect(-18, -6, 34, 12, 4);
                    ctx.fill();
                    strokeSoft();

                    // Scope
                    ctx.fillStyle = '#14171b';
                    ctx.beginPath();
                    ctx.roundRect(-6, -14, 30, 6, 3);
                    ctx.fill();
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.roundRect(-10, -15, 6, 8, 3);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.roundRect(24, -15, 6, 8, 3);
                    ctx.fill();
                    ctx.globalAlpha = 0.18;
                    ctx.fillStyle = '#e5e7eb';
                    ctx.fillRect(-4, -13, 24, 2);
                    ctx.globalAlpha = 1;

                    // Stock
                    ctx.fillStyle = '#1b1f26';
                    ctx.beginPath();
                    ctx.moveTo(-18, -5);
                    ctx.lineTo(-52, -14);
                    ctx.lineTo(-60, -8);
                    ctx.lineTo(-60, 8);
                    ctx.lineTo(-52, 14);
                    ctx.lineTo(-18, 5);
                    ctx.closePath();
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();

                    // Bipod
                    ctx.globalAlpha = 0.75;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(18, 2);
                    ctx.lineTo(10, 14);
                    ctx.moveTo(22, 2);
                    ctx.lineTo(28, 14);
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                },

                machete: () => {
                    // Handle
                    ctx.fillStyle = '#1a1a1a';
                    ctx.beginPath();
                    ctx.roundRect(-18, -5, 18, 10, 4);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();

                    // Guard
                    ctx.fillStyle = metal(-10, -8, 10, 8);
                    ctx.beginPath();
                    ctx.roundRect(-2, -7, 6, 14, 3);
                    ctx.fill();

                    // Blade (metal)
                    const g = ctx.createLinearGradient(0, -10, 70, 10);
                    g.addColorStop(0, '#2b2f36');
                    g.addColorStop(0.35, '#cbd5e1');
                    g.addColorStop(1, '#1b1f26');
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.moveTo(2, -5);
                    ctx.lineTo(70, -10);
                    ctx.lineTo(64, 10);
                    ctx.lineTo(2, 5);
                    ctx.closePath();
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();

                    // Edge highlight
                    ctx.globalAlpha = 0.25;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(10, -3);
                    ctx.lineTo(66, -8);
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                },

                flamethrower: () => {
                    // body
                    ctx.fillStyle = '#2b2b2b';
                    ctx.fillRect(-18, -6, 44, 12);
                    // barrel
                    ctx.fillStyle = '#111';
                    ctx.fillRect(26, -4, 18, 8);
                    // nozzle
                    ctx.fillStyle = '#666';
                    ctx.fillRect(42, -2, 8, 4);
                    // top pipe
                    ctx.fillStyle = '#444';
                    ctx.fillRect(-4, -10, 24, 4);
                    // grip
                    ctx.fillStyle = '#1a1a1a';
                    ctx.beginPath();
                    ctx.moveTo(6, 6);
                    ctx.lineTo(10, 22);
                    ctx.lineTo(0, 22);
                    ctx.lineTo(-4, 6);
                    ctx.closePath();
                    ctx.fill();
                    // ignition glow
                    ctx.save();
                    ctx.globalAlpha = 0.55;
                    ctx.shadowBlur = 14;
                    ctx.shadowColor = '#ff7a00';
                    ctx.fillStyle = '#ff7a00';
                    ctx.beginPath();
                    ctx.arc(46, 0, 3.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                },

                // MESH: dual pistols (two compact pistols)
                mesh_dual: () => {
                    const drawCompactPistol = (ox, oy) => {
                        ctx.save();
                        ctx.translate(ox, oy);
                        ctx.scale(0.9, 0.9);

                        // slide
                        ctx.fillStyle = metal(-20, -10, 26, 10);
                        ctx.beginPath();
                        ctx.roundRect(-14, -6, 30, 12, 4);
                        ctx.fill();
                        strokeSoft();

                        // barrel
                        ctx.fillStyle = parker(14, -6, 32, 6);
                        ctx.beginPath();
                        ctx.roundRect(14, -3, 12, 6, 3);
                        ctx.fill();
                        ctx.fillStyle = '#0a0a0a';
                        ctx.beginPath();
                        ctx.arc(26, 0, 2, 0, Math.PI * 2);
                        ctx.fill();

                        // grip
                        ctx.save();
                        ctx.translate(-4, 6);
                        ctx.rotate(0.32);
                        ctx.fillStyle = '#111317';
                        ctx.beginPath();
                        ctx.roundRect(-6, 0, 12, 14, 3);
                        ctx.fill();
                        ctx.restore();

                        // tiny highlight
                        ctx.globalAlpha = 0.22;
                        ctx.fillStyle = '#e5e7eb';
                        ctx.fillRect(-2, -4, 10, 2);
                        ctx.globalAlpha = 1;

                        ctx.restore();
                    };

                    // Two pistols, slightly separated
                    drawCompactPistol(0, -10);
                    drawCompactPistol(0, 10);
                }
            };

            // Disable shadow for crisp HUD/pickups; keep subtle world shading
            ctx.shadowBlur = 0;
            if (shapes[type]) shapes[type]();
            ctx.restore();
        }

        function draw() {
            // Level-themed backdrop (screen-space)
            const bgA = hardMode ? '#1a0a0a' : (levelTheme?.floorA || '#1a1a1a');
            ctx.fillStyle = bgA;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // HoTRoD intro cutscene draw (special)
            if (hotrodCutscene.active) {
                drawHotrodCutscene();
                return;
            }

            if (gameState !== 'playing' && gameState !== 'paused') return;

            ctx.save();
            ctx.translate(-camera.x + camera.shakeX, -camera.y + camera.shakeY);

            // Subtle level tint layer
            if (levelTheme?.ambient) {
                const amb = levelTheme.ambient;
                ctx.save();
                ctx.globalAlpha = 0.08;
                const g = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, 900);
                g.addColorStop(0, amb.colorA);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.fillRect(camera.x, camera.y, canvas.width, canvas.height);
                ctx.restore();
            }

            // Grid (world-space)
            if (currentLevel !== 102) {
                ctx.strokeStyle = hardMode ? '#3a1a1a' : (levelTheme?.grid || '#2a2a2a');
                ctx.lineWidth = 1;
                // Slightly coarser grid on heavy levels for performance
                const gridSize = (currentLevel === 2 || currentLevel === 4 || currentLevel === 5) ? 60 : 50;
                const startX = Math.floor(camera.x / gridSize) * gridSize;
                const startY = Math.floor(camera.y / gridSize) * gridSize;
                for (let i = startX; i < camera.x + canvas.width; i += gridSize) { ctx.beginPath(); ctx.moveTo(i, camera.y); ctx.lineTo(i, camera.y + canvas.height); ctx.stroke(); }
                for (let i = startY; i < camera.y + canvas.height; i += gridSize) { ctx.beginPath(); ctx.moveTo(camera.x, i); ctx.lineTo(camera.x + canvas.width, i); ctx.stroke(); }
            }

            // Skyward Ascent: draw rooftop surfaces (decor only)
            if (currentLevel === 102 && skywardDecor && skywardDecor.buildings.length) {
                const firstRoof = skywardDecor.buildings[0];
                const lastRoof = skywardDecor.buildings[skywardDecor.buildings.length - 1];

                // Лёгкие медленные "облака" вокруг зданий (визуально, без нагрузки)
                const cloudBandTop = firstRoof.y - 260;
                const cloudBandBottom = firstRoof.y - 40;
                const bandX = firstRoof.x - 180;
                const bandW = (lastRoof.x + lastRoof.w) - bandX + 360;
                const tCloud = performance.now() * 0.00005; // медленное движение

                ctx.save();
                ctx.globalAlpha = 0.22;
                for (let i = 0; i < 6; i++) {
                    const baseX = bandX + (bandW / 5) * i;
                    const offset = Math.sin(tCloud + i * 1.7) * 120;
                    const x = baseX + offset;
                    const y = cloudBandTop + (cloudBandBottom - cloudBandTop) * (0.3 + 0.1 * i);
                    const r = 180 + 40 * Math.sin(tCloud * 0.5 + i);

                    const cg = ctx.createRadialGradient(x, y, 0, x, y, r);
                    cg.addColorStop(0, 'rgba(255,255,255,0.18)');
                    cg.addColorStop(0.4, 'rgba(220,235,250,0.16)');
                    cg.addColorStop(1, 'rgba(220,235,250,0)');
                    ctx.fillStyle = cg;
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();

                // Сами крыши
                for (const b of skywardDecor.buildings) {
                    ctx.save();
                    const gg = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
                    gg.addColorStop(0, 'rgba(245, 250, 255, 0.95)');
                    gg.addColorStop(1, 'rgba(200, 214, 230, 0.92)');
                    ctx.fillStyle = gg;
                    ctx.fillRect(b.x, b.y, b.w, b.h);

                    ctx.globalAlpha = 0.35;
                    ctx.strokeStyle = 'rgba(20, 30, 40, 0.45)';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
                    ctx.restore();
                }

                // Доски между зданиями
                for (const br of skywardDecor.bridges) {
                    ctx.save();
                    ctx.fillStyle = 'rgba(170, 120, 70, 0.95)';
                    ctx.fillRect(br.x, br.y, br.w, br.h);
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#000';
                    for (let i = 0; i < br.w; i += 22) {
                        ctx.fillRect(br.x + i + 6, br.y + 4, 2, br.h - 8);
                    }
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = 'rgba(40, 25, 15, 0.65)';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(br.x, br.y, br.w, br.h);
                    ctx.restore();
                }
            }

            walls.forEach(w => {
                // Skyward Ascent: draw roof parapets in a bright style (no gray border walls)
                if (currentLevel === 102) {
                    if (!w.skywardParapet) return;
                    ctx.save();
                    ctx.fillStyle = 'rgba(255,255,255,0.72)';
                    ctx.fillRect(w.x, w.y, w.width, w.height);
                    ctx.globalAlpha = 0.35;
                    ctx.strokeStyle = 'rgba(30, 50, 70, 0.55)';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(w.x + 1, w.y + 1, w.width - 2, w.height - 2);
                    ctx.restore();
                    return;
                }

                const wallFillByLevel = {
                    1: '#3b3b3b', // warehouse concrete
                    2: '#2b2f3f', // office walls
                    3: '#2f3a35', // factory metal
                    4: '#25332e', // HQ concrete
                    5: '#26262e'
                };
                ctx.fillStyle = hardMode ? '#553333' : (wallFillByLevel[currentLevel] || '#444');
                ctx.fillRect(w.x, w.y, w.width, w.height);
                ctx.strokeStyle = hardMode ? '#774444' : '#666';
                ctx.lineWidth = 2;
                ctx.strokeRect(w.x, w.y, w.width, w.height);

                // Level accents: factory caution stripes, hell scorched edges
                if (currentLevel === 3 && w.width > 120 && w.height < 80) {
                    ctx.save();
                    ctx.globalAlpha = 0.35;
                    ctx.translate(w.x, w.y);
                    ctx.fillStyle = '#f6c945';
                    for (let i = 0; i < w.width; i += 16) {
                        ctx.save();
                        ctx.translate(i, 0);
                        ctx.rotate(-Math.PI / 4);
                        ctx.fillRect(-10, 8, 8, w.height * 1.2);
                        ctx.restore();
                    }
                    ctx.globalAlpha = 0.55;
                    ctx.fillStyle = '#111';
                    for (let i = 8; i < w.width; i += 16) {
                        ctx.save();
                        ctx.translate(i, 0);
                        ctx.rotate(-Math.PI / 4);
                        ctx.fillRect(-10, 8, 8, w.height * 1.2);
                        ctx.restore();
                    }
                    ctx.restore();
                }

                if (currentLevel === 4 && w.width > 140 && w.height > 26) {
                    // HQ: subtle tactical markings (no heavy glow)
                    ctx.save();
                    ctx.globalAlpha = 0.18;
                    ctx.strokeStyle = 'rgba(170, 255, 210, 0.55)';
                    ctx.lineWidth = 2;
                    // corner ticks
                    ctx.beginPath();
                    ctx.moveTo(w.x + 10, w.y + 10);
                    ctx.lineTo(w.x + 36, w.y + 10);
                    ctx.moveTo(w.x + 10, w.y + 10);
                    ctx.lineTo(w.x + 10, w.y + 36);

                    ctx.moveTo(w.x + w.width - 10, w.y + 10);
                    ctx.lineTo(w.x + w.width - 36, w.y + 10);
                    ctx.moveTo(w.x + w.width - 10, w.y + 10);
                    ctx.lineTo(w.x + w.width - 10, w.y + 36);

                    ctx.moveTo(w.x + 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + 36, w.y + w.height - 10);
                    ctx.moveTo(w.x + 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + 10, w.y + w.height - 36);

                    ctx.moveTo(w.x + w.width - 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + w.width - 36, w.y + w.height - 10);
                    ctx.moveTo(w.x + w.width - 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + w.width - 10, w.y + w.height - 36);
                    ctx.stroke();
                    ctx.restore();
                }
            });

            obstacles.forEach(o => {
                ctx.fillStyle = o.color;
                ctx.fillRect(o.x, o.y, o.width, o.height);
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.strokeRect(o.x, o.y, o.width, o.height);

                if (o.type === 'box') {
                    ctx.strokeStyle = '#555';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(o.x, o.y);
                    ctx.lineTo(o.x + o.width, o.y + o.height);
                    ctx.moveTo(o.x + o.width, o.y);
                    ctx.lineTo(o.x, o.y + o.height);
                    ctx.stroke();
                } else if (o.type === 'explosive_barrel') {
                    // HoTRoD explosive barrel: red with warning stripes
                    ctx.save();
                    ctx.fillStyle = '#c40000';
                    ctx.fillRect(o.x, o.y, o.width, o.height);
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(o.x, o.y, o.width, o.height);

                    ctx.globalAlpha = 0.85;
                    ctx.fillStyle = 'rgba(255,255,255,0.22)';
                    ctx.fillRect(o.x + 4, o.y + o.height * 0.28, o.width - 8, 3);
                    ctx.fillRect(o.x + 4, o.y + o.height * 0.68, o.width - 8, 3);

                    // Hit counter
                    const left = Math.max(0, (o.hitsToExplode || 3) - (o.hits || 0));
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = '#fff';
                    ctx.font = 'bold 12px Arial';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(left, o.x + o.width / 2, o.y + o.height / 2);

                    // subtle glow when close to explosion
                    if (left <= 1) {
                        ctx.globalAlpha = 0.35;
                        ctx.shadowBlur = 18;
                        ctx.shadowColor = '#ff0000';
                        ctx.strokeStyle = '#ffb3b3';
                        ctx.lineWidth = 3;
                        ctx.strokeRect(o.x - 2, o.y - 2, o.width + 4, o.height + 4);
                    }
                    ctx.restore();
                } else if (o.type === 'barrel') {
                    ctx.fillStyle = 'rgba(255,255,255,0.12)';
                    ctx.fillRect(o.x + 5, o.y + o.height * 0.3, o.width - 10, 3);
                    ctx.fillRect(o.x + 5, o.y + o.height * 0.7, o.width - 10, 3);
                } else if (o.type === 'table' && currentLevel === 2) {
                    // office vibe: simple outline (optimized)
                    ctx.save();
                    ctx.globalAlpha = 0.20;
                    ctx.strokeStyle = '#7cf7ff';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(o.x + 2, o.y + 2, o.width - 4, o.height - 4);
                    ctx.restore();
                }

            });

            // Ambient particles and graffiti (in-world)
            drawAmbient();
            drawGraffiti();

            // Scorch marks (black residue after explosions)
            if (scorchMarks.length) {
                ctx.save();
                ctx.globalCompositeOperation = 'multiply';
                for (const s of scorchMarks) {
                    const a = Math.max(0, Math.min(1, s.life / s.maxLife));
                    // fade in quickly, fade out slowly
                    const alpha = 0.45 * Math.pow(a, 1.25);
                    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
                    g.addColorStop(0, `rgba(0,0,0,${0.35 * alpha})`);
                    g.addColorStop(0.55, `rgba(0,0,0,${0.22 * alpha})`);
                    g.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.globalAlpha = alpha;
                    ctx.fillStyle = 'rgba(0,0,0,0.55)';
                    for (const b of s.blots) {
                        const bx = s.x + Math.cos(b.a) * b.d;
                        const by = s.y + Math.sin(b.a) * b.d;
                        ctx.beginPath();
                        ctx.arc(bx, by, b.r, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    ctx.globalAlpha = 1;
                }
                ctx.restore();
            }

            // Flamethrower effects (only flame visuals; no range hint cone)
            drawFlame();

            // Pyro ability visual: animated fire ring around the player
            if (selectedCharacter === 'pyro' && pyroAura.active) {
                const t = performance.now() * 0.001;
                const r = pyroAura.radius;

                // soft outer glow ring
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                const g = ctx.createRadialGradient(player.x, player.y, r * 0.45, player.x, player.y, r * 1.15);
                g.addColorStop(0, 'rgba(255, 140, 0, 0)');
                g.addColorStop(0.55, 'rgba(255, 140, 0, 0.08)');
                g.addColorStop(0.80, 'rgba(255, 70, 0, 0.14)');
                g.addColorStop(1, 'rgba(255, 0, 0, 0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(player.x, player.y, r * 1.12, 0, Math.PI * 2);
                ctx.fill();

                // main ring stroke
                const pulse = 1.0 + 0.03 * Math.sin(t * 6);
                ctx.globalAlpha = 0.75;
                ctx.lineWidth = 10;
                ctx.strokeStyle = 'rgba(255, 110, 0, 0.65)';
                ctx.beginPath();
                ctx.arc(player.x, player.y, r * pulse, 0, Math.PI * 2);
                ctx.stroke();

                // tongues of flame (arclets)
                ctx.globalAlpha = 0.85;
                const tongues = 26;
                for (let i = 0; i < tongues; i++) {
                    const a = (Math.PI * 2) * (i / tongues) + t * 0.8;
                    const wob = 10 * (0.5 + 0.5 * Math.sin(t * 3.5 + i));
                    const rr = r + wob;
                    const x = player.x + Math.cos(a) * rr;
                    const y = player.y + Math.sin(a) * rr;

                    const tg = ctx.createRadialGradient(x, y, 0, x, y, 26);
                    tg.addColorStop(0, 'rgba(255, 255, 220, 0.24)');
                    tg.addColorStop(0.35, 'rgba(255, 180, 60, 0.22)');
                    tg.addColorStop(0.7, 'rgba(255, 70, 0, 0.14)');
                    tg.addColorStop(1, 'rgba(160, 0, 0, 0)');
                    ctx.fillStyle = tg;
                    ctx.beginPath();
                    ctx.arc(x, y, 22 + wob * 0.25, 0, Math.PI * 2);
                    ctx.fill();
                }

                ctx.restore();
            }

            // Level 4: HQ floor marking (subtle, military style)
            if (currentLevel === 4) {
                const cx = WORLD_WIDTH * 0.55;
                const cy = WORLD_HEIGHT * 0.55;
                ctx.save();
                ctx.globalAlpha = 0.10;
                ctx.strokeStyle = 'rgba(170, 255, 210, 0.65)';
                ctx.lineWidth = 3;
                // simple target/zone ring (no glow)
                ctx.beginPath();
                ctx.arc(cx, cy, 120, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(cx, cy, 60, 0, Math.PI * 2);
                ctx.stroke();
                // crosshair
                ctx.beginPath();
                ctx.moveTo(cx - 140, cy);
                ctx.lineTo(cx - 90, cy);
                ctx.moveTo(cx + 90, cy);
                ctx.lineTo(cx + 140, cy);
                ctx.moveTo(cx, cy - 140);
                ctx.lineTo(cx, cy - 90);
                ctx.moveTo(cx, cy + 90);
                ctx.lineTo(cx, cy + 140);
                ctx.stroke();

                ctx.restore();
            }

            if (currentLevel === 0) tutorialTargets.forEach(t => { ctx.fillStyle = t.color; ctx.beginPath(); ctx.arc(t.x, t.y, t.radius, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); if (!t.hit) { ctx.fillStyle = '#fff'; ctx.font = 'bold 15px Courier New'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🎯', t.x, t.y); } });

            // Explosion shockwaves (world-space)
            if (shockwaves.length) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (const s of shockwaves) {
                    const a = Math.max(0, s.life / s.maxLife);
                    ctx.globalAlpha = 0.35 * a;
                    ctx.strokeStyle = s.color || 'rgba(255,140,0,0.9)';
                    ctx.lineWidth = 10 * a + 2;
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
                    ctx.stroke();

                    ctx.globalAlpha = 0.10 * a;
                    ctx.lineWidth = 28 * a + 2;
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, s.r * 0.92, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
                ctx.restore();
            }

            // Grenade pickups (HoTRoD)
            grenadePickups.forEach(gp => {
                const pulse = Math.sin(Date.now() / 180) * 2.0;
                ctx.save();
                ctx.shadowBlur = 18;
                ctx.shadowColor = '#ffaa00';
                const rg = ctx.createRadialGradient(gp.x, gp.y, 0, gp.x, gp.y, gp.radius + 14);
                rg.addColorStop(0, 'rgba(255, 240, 180, 0.22)');
                rg.addColorStop(0.35, 'rgba(255, 170, 60, 0.45)');
                rg.addColorStop(1, 'rgba(255, 90, 0, 0.06)');
                ctx.fillStyle = rg;
                ctx.beginPath();
                ctx.arc(gp.x, gp.y, gp.radius + pulse + 8, 0, Math.PI * 2);
                ctx.fill();

                ctx.shadowBlur = 0;
                ctx.fillStyle = 'rgba(12, 10, 10, 0.72)';
                ctx.beginPath();
                ctx.arc(gp.x, gp.y, gp.radius + pulse, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(gp.x, gp.y, gp.radius + pulse, 0, Math.PI * 2);
                ctx.stroke();

                ctx.fillStyle = '#fff';
                ctx.font = 'bold 16px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('💣', gp.x, gp.y - 1);

                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.font = 'bold 12px Arial';
                ctx.fillText(`+${gp.amount || 1}`, gp.x, gp.y + 18);
                ctx.restore();
            });

            // Flamethrower fuel pickups (+30)
            flameFuelPickups.forEach(f => {
                const pulse = Math.sin(Date.now() / 180) * 2.2;
                ctx.save();
                ctx.shadowBlur = 20;
                ctx.shadowColor = '#ff7a00';
                const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.radius + 12);
                g.addColorStop(0, 'rgba(255, 255, 220, 0.25)');
                g.addColorStop(0.35, 'rgba(255, 170, 60, 0.45)');
                g.addColorStop(1, 'rgba(255, 80, 0, 0.08)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(f.x, f.y, f.radius + pulse + 8, 0, Math.PI * 2);
                ctx.fill();

                ctx.shadowBlur = 0;
                ctx.fillStyle = 'rgba(20, 10, 10, 0.75)';
                ctx.beginPath();
                ctx.arc(f.x, f.y, f.radius + pulse, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(f.x, f.y, f.radius + pulse, 0, Math.PI * 2);
                ctx.stroke();

                ctx.fillStyle = '#fff';
                ctx.font = 'bold 18px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('🔥', f.x, f.y - 2);

                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.font = 'bold 12px Arial';
                ctx.fillText(`+30`, f.x, f.y + 18);
                ctx.restore();
            });

            weaponPickups.forEach(p => { const pulse = Math.sin(Date.now() / 200) * 3; ctx.shadowBlur = 20; ctx.shadowColor = p.weapon.color; ctx.fillStyle = p.weapon.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + pulse, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4); drawWeapon(0, 0, p.weaponType, 0.8); ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Arial'; ctx.textAlign = 'center'; ctx.fillText(p.weapon.name, p.x, p.y - 35); });

            enemies.forEach(e => {
                // Gunnest: draw a turret base behind the gray unit
                if (e.type === 'gunnest') {
                    ctx.save();
                    // base
                    ctx.fillStyle = 'rgba(30,30,35,0.9)';
                    ctx.beginPath();
                    ctx.roundRect(e.x - 28, e.y - 18, 56, 36, 10);
                    ctx.fill();
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(e.x - 18, e.y - 2, 36, 3);
                    ctx.globalAlpha = 1;
                    // barrel direction hint
                    const a = Math.atan2(player.y - e.y, player.x - e.x);
                    ctx.strokeStyle = 'rgba(220,220,220,0.75)';
                    ctx.lineWidth = 5;
                    ctx.beginPath();
                    ctx.moveTo(e.x + Math.cos(a) * 6, e.y + Math.sin(a) * 6);
                    ctx.lineTo(e.x + Math.cos(a) * 34, e.y + Math.sin(a) * 34);
                    ctx.stroke();
                    ctx.restore();
                }

                ctx.fillStyle = e.color;
                ctx.beginPath();
                ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.globalAlpha = 1;
                const barWidth = 40, barHeight = 6, hpPercent = e.hp / e.maxHP;
                ctx.fillStyle = '#000';
                ctx.fillRect(e.x - barWidth/2, e.y - e.radius - 15, barWidth, barHeight);
                ctx.fillStyle = hpPercent > 0.6 ? '#0f0' : hpPercent > 0.3 ? '#ff0' : '#f00';
                ctx.fillRect(e.x - barWidth/2, e.y - e.radius - 15, barWidth * hpPercent, barHeight);

                ctx.fillStyle = '#fff';
                ctx.font = '10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText({ melee: '⚔️', ranged: '🔫', sniper: '🎯', tank: '🛡️', ambush: '👁️', miniganer: '🌀', gunnest: '🛠️' }[e.type] || '', e.x, e.y - e.radius - 20);
            });

            if (miniBoss) { ctx.save(); ctx.translate(miniBoss.x, miniBoss.y); ctx.rotate(miniBoss.rotation); ctx.fillStyle = miniBoss.color; ctx.beginPath(); ctx.arc(0, 0, miniBoss.radius, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#8B4513'; ctx.beginPath(); ctx.ellipse(0, -miniBoss.radius - 5, miniBoss.radius * 1.3, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(-miniBoss.radius * 0.6, -miniBoss.radius - 25, miniBoss.radius * 1.2, 20); ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(miniBoss.x, miniBoss.y, miniBoss.radius, 0, Math.PI * 2); ctx.stroke(); }

            if (boss) { ctx.save(); ctx.translate(boss.x, boss.y); ctx.rotate(boss.rotation); ctx.fillStyle = ['#ff6600', '#ff3300', '#ff0000', '#cc0000'][boss.phase - 1]; ctx.beginPath(); ctx.arc(0, 0, boss.radius, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(-boss.radius, -10); ctx.lineTo(-boss.radius - 15, -25); ctx.lineTo(-boss.radius - 5, -15); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(boss.radius, -10); ctx.lineTo(boss.radius + 15, -25); ctx.lineTo(boss.radius + 5, -15); ctx.closePath(); ctx.fill(); ctx.fillStyle = boss.phase >= 3 ? '#ffff00' : '#ff0000'; ctx.beginPath(); ctx.arc(-15, 0, 8, 0, Math.PI * 2); ctx.arc(15, 0, 8, 0, Math.PI * 2); ctx.fill(); ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(boss.x, boss.y, boss.radius, 0, Math.PI * 2); ctx.stroke(); }

            ctx.save(); ctx.translate(player.x, player.y); const angle = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x); ctx.rotate(angle); drawWeapon(player.radius + 5, 0, player.weapon, 1); ctx.restore();

            // Player body
            ctx.fillStyle = player.color;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
            ctx.fill();

            // Skyler: red outline
            if (selectedCharacter === 'skyler') {
                ctx.save();
                ctx.strokeStyle = '#ff3b3b';
                ctx.lineWidth = 5;
                ctx.beginPath();
                ctx.arc(player.x, player.y, player.radius + 1, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }

            // Special look: Pyro (orange-red circle + 2 red tanks behind)
            if (selectedCharacter === 'pyro') {
                const a = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x);
                const back = a + Math.PI;
                ctx.save();
                ctx.translate(player.x, player.y);

                // body gradient
                const grad = ctx.createRadialGradient(0, -4, 2, 0, 0, player.radius + 10);
                grad.addColorStop(0, 'rgba(255, 240, 170, 0.35)');
                grad.addColorStop(0.25, 'rgba(255, 140, 0, 0.55)');
                grad.addColorStop(1, 'rgba(170, 10, 0, 0.25)');
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(0, 0, player.radius + 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalCompositeOperation = 'source-over';

                // two tanks behind
                const tankOffset = 10;
                const tankDist = player.radius + 10;
                const bx = Math.cos(back) * tankDist;
                const by = Math.sin(back) * tankDist;

                for (const s of [-1, 1]) {
                    const ox = bx + Math.cos(back + Math.PI / 2) * (tankOffset * s);
                    const oy = by + Math.sin(back + Math.PI / 2) * (tankOffset * s);

                    // cylinder
                    ctx.save();
                    ctx.translate(ox, oy);
                    ctx.rotate(a);
                    ctx.fillStyle = '#b10000';
                    ctx.strokeStyle = '#4a0000';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.roundRect(-6, -14, 12, 28, 6);
                    ctx.fill();
                    ctx.stroke();

                    // highlight
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#ff4040';
                    ctx.fillRect(-4, -12, 2, 24);
                    ctx.globalAlpha = 1;

                    // valve cap
                    ctx.fillStyle = '#222';
                    ctx.beginPath();
                    ctx.arc(0, -16, 4, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.restore();
                }

                ctx.restore();
            }

            if (player.hasTopLine) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(player.x - player.radius + 5, player.y - player.radius + 5); ctx.lineTo(player.x + player.radius - 5, player.y - player.radius + 5); ctx.stroke(); }
            if (player.color === '#ff8800') { ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2); ctx.stroke(); }
            if (player.color === '#40E0D0') { ctx.save(); ctx.translate(player.x, player.y); ctx.rotate(-Math.PI / 4); ctx.fillStyle = '#8B4513'; ctx.fillRect(-player.radius - 10, -5, player.radius * 2 + 20, 10); for (let i = -player.radius; i <= player.radius; i += 15) { ctx.fillStyle = '#FFD700'; ctx.fillRect(i, -8, 6, 8); ctx.fillStyle = '#ff0000'; ctx.beginPath(); ctx.moveTo(i + 3, -13); ctx.lineTo(i, -8); ctx.lineTo(i + 6, -8); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#ffcccc'; ctx.beginPath(); ctx.moveTo(i + 3, -13); ctx.lineTo(i + 1, -11); ctx.lineTo(i + 3, -8); ctx.closePath(); ctx.fill(); } ctx.restore(); }
            if (player.color === '#9933FF') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(player.x, player.y - 5, 8, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(player.x - 4, player.y - 7, 1.5, 0, Math.PI * 2); ctx.arc(player.x + 4, player.y - 7, 1.5, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(player.x, player.y - 3); ctx.lineTo(player.x - 2, player.y + 1); ctx.lineTo(player.x + 2, player.y + 1); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(player.x - 5, player.y + 5); ctx.lineTo(player.x + 5, player.y + 5); ctx.arc(player.x, player.y + 5, 5, 0, Math.PI, true); ctx.closePath(); ctx.fill(); }

            ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2); ctx.stroke();

            if (abilityActive && selectedCharacter === 'tank') { ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#00ffff'; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 15, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 0.6; ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 4; ctx.shadowBlur = 20; ctx.shadowColor = '#00ffff'; ctx.stroke(); ctx.restore(); }
            if (abilityActive && selectedCharacter === 'machete_char') { ctx.save(); ctx.globalAlpha = 0.4; ctx.strokeStyle = '#ff0000'; ctx.lineWidth = 6; ctx.shadowBlur = 25; ctx.shadowColor = '#ff0000'; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 20, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
            if (macheteSlash) { ctx.save(); ctx.translate(macheteSlash.x, macheteSlash.y); ctx.rotate(macheteSlash.angle); const alpha = macheteSlash.duration / 10; ctx.strokeStyle = abilityActive && selectedCharacter === 'machete_char' ? `rgba(255, 0, 0, ${alpha})` : `rgba(153, 51, 255, ${alpha})`; ctx.lineWidth = abilityActive && selectedCharacter === 'machete_char' ? 8 : 5; ctx.beginPath(); ctx.arc(0, 0, macheteSlash.radius, -Math.PI / 4, Math.PI / 4); ctx.stroke(); ctx.restore(); }

            // Player bullets
            bullets.forEach(b => {
                if (b.fromSkyler) {
                    // Пиксельный след для очереди Skyler
                    ctx.save();
                    ctx.shadowBlur = 8;
                    ctx.shadowColor = '#a855f7';
                    const segs = 3;
                    for (let i = 0; i < segs; i++) {
                        const t = i / segs;
                        const px = b.x - b.speedX * t * 0.4;
                        const py = b.y - b.speedY * t * 0.4;
                        const size = 2 + (segs - i);
                        ctx.globalAlpha = 0.35 + 0.2 * (1 - t);
                        ctx.fillStyle = i === 0 ? '#e9d5ff' : (i === 1 ? '#c4b5fd' : '#a855f7');
                        ctx.fillRect(px - size / 2, py - size / 2, size, size);
                    }
                    ctx.globalAlpha = 1;
                    ctx.shadowBlur = 0;
                    ctx.restore();
                } else {
                    ctx.fillStyle = b.color;
                    ctx.shadowBlur = 15;
                    ctx.shadowColor = b.color;
                    ctx.beginPath();
                    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                }
            });

            // Muzzle flashes (dual pistols)
            if (muzzleFlashes.length) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (const f of muzzleFlashes) {
                    const a = Math.max(0, f.life / f.maxLife);
                    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 22);
                    g.addColorStop(0, `rgba(255, 245, 210, ${0.35 * a})`);
                    g.addColorStop(0.35, `rgba(255, 210, 90, ${0.28 * a})`);
                    g.addColorStop(1, 'rgba(255, 120, 0, 0)');
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.arc(f.x, f.y, 22, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }

            // Draw MESH grenades
            meshGrenades.forEach(g => {
                const pulse = Math.sin(g.timer * 0.3) * 2;
                const urgency = g.timer < 60 ? (1 - g.timer / 60) : 0;
                
                // Grenade body
                ctx.save();
                ctx.shadowBlur = 15 + urgency * 20;
                ctx.shadowColor = g.timer < 60 ? '#ff0000' : '#ffaa00';
                ctx.fillStyle = g.timer < 60 ? `rgb(${180 + urgency * 75}, ${50 - urgency * 50}, 0)` : '#555';
                ctx.beginPath();
                ctx.arc(g.x, g.y, g.radius + pulse, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.shadowBlur = 0;
                
                // Timer indicator
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 12px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(Math.ceil(g.timer / 60), g.x, g.y);
                ctx.restore();
            });

            enemyBullets.forEach(b => { if (b.mine) { ctx.fillStyle = b.timer < 30 ? '#ff0000' : '#ff00ff'; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center'; ctx.fillText(Math.ceil(b.timer / 30), b.x, b.y + 3); } else { ctx.fillStyle = b.color; ctx.shadowBlur = b.homing ? 20 : 10; ctx.shadowColor = b.color; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; } });

            ctx.restore();

            if (boss) {
                const bX = boss.x - camera.x, bY = boss.y - camera.y;
                if (bX < -boss.radius || bX > canvas.width + boss.radius || bY < -boss.radius || bY > canvas.height + boss.radius) {
                    const cX = canvas.width / 2, cY = canvas.height / 2, a = Math.atan2(bY - cY, bX - cX), dx = Math.cos(a), dy = Math.sin(a);
                    const margin = 100, dists = [dx > 0 ? (canvas.width - margin - cX) / dx : Infinity, dx < 0 ? (margin - cX) / dx : Infinity, dy > 0 ? (canvas.height - margin - cY) / dy : Infinity, dy < 0 ? (margin - cY) / dy : Infinity];
                    const minD = Math.min(...dists), iX = cX + dx * minD, iY = cY + dy * minD;
                    ctx.save(); ctx.translate(iX, iY); ctx.rotate(a); ctx.fillStyle = '#ff0000'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.shadowBlur = 15; ctx.shadowColor = '#ff0000'; ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(-10, -15); ctx.lineTo(-5, 0); ctx.lineTo(-10, 15); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = 'bold 16px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('💀', -5, 0); ctx.restore();
                }
            }

            // Screen flash after explosions (screen-space overlay)
            if (screenFlash > 0) {
                ctx.save();
                ctx.globalCompositeOperation = 'screen';
                ctx.globalAlpha = Math.min(1, screenFlash);
                const fg = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.7);
                fg.addColorStop(0, 'rgba(255, 220, 160, 0.55)');
                fg.addColorStop(0.35, 'rgba(255, 120, 40, 0.22)');
                fg.addColorStop(1, 'rgba(255, 60, 0, 0)');
                ctx.fillStyle = fg;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.restore();
            }

            if (player.hp < player.maxHP * 0.5) {
                const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width * 0.7);
                vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
                vignette.addColorStop(1, `rgba(255, 0, 0, ${0.3 * (1 - player.hp / (player.maxHP * 0.5))})`);
                ctx.fillStyle = vignette;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            ctx.strokeStyle = '#00ff00'; ctx.lineWidth = 2; ctx.shadowBlur = 5; ctx.shadowColor = '#00ff00'; ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 20, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(mouse.x - 25, mouse.y); ctx.lineTo(mouse.x - 8, mouse.y); ctx.moveTo(mouse.x + 25, mouse.y); ctx.lineTo(mouse.x + 8, mouse.y); ctx.moveTo(mouse.x, mouse.y - 25); ctx.lineTo(mouse.x, mouse.y - 8); ctx.moveTo(mouse.x, mouse.y + 25); ctx.lineTo(mouse.x, mouse.y + 8); ctx.stroke(); ctx.shadowBlur = 0;
        }

        function updateHUD() {
            const hp = Math.max(0, Math.floor(player.hp));
            const maxHP = player.maxHP;

            const hpEl = document.getElementById('playerHP');
            const maxHpEl = document.getElementById('playerMaxHP');
            const ammoEl = document.getElementById('ammo');
            const weaponNameEl = document.getElementById('weaponName');

            if (hpEl) hpEl.textContent = hp;
            if (maxHpEl) maxHpEl.textContent = maxHP;
            if (weaponNameEl) weaponNameEl.textContent = currentWeapon.name;
            if (ammoEl) ammoEl.textContent = currentWeapon.ammo === Infinity ? '∞' : currentWeapon.ammo;

            // HUD animations
            if (prevHudHP !== null && hp !== prevHudHP) {
                hudPulse(hudHP, 'pop');
                if (hp < prevHudHP) hudPulse(hudHP, 'hit');
            }

            const ammoVal = currentWeapon.ammo === Infinity ? Infinity : currentWeapon.ammo;
            if (prevHudAmmo !== null && ammoVal !== prevHudAmmo) {
                hudPulse(hudAmmo, 'pop');
            }

            if (hudHP) {
                const danger = (hp / maxHP) <= 0.35;
                hudHP.classList.toggle('danger', danger);
            }

            prevHudHP = hp;
            prevHudAmmo = ammoVal;
        }

        function gameOver() {
            gameState = 'gameover';
            stopMusic();
            stopAllHtmlMusic(true);
            document.getElementById('miniBossHealth').style.display = 'none';
            document.getElementById('deathKills').textContent = kills;
            document.getElementById('deathTotal').textContent = totalEnemies;
            document.getElementById('deathMenu').style.display = 'block';
        }
        function levelComplete() {
            gameState = 'complete';
            stopMusic();
            stopAllHtmlMusic(true);

            if (hardMode) {
                // If we're on the boss (level 5) OR progress already reached 5, finish hard-mode.
                if (currentLevel === 5 || hardModeProgress >= 5) {
                    setTimeout(() => {
                        showGameAlert('🎉 HARD-MODE ПРОЙДЕН!\n\nВы победили!\n\nВсе уровни пройдены!', 'Победа').then(() => {
                            hardMode = false;
                            backToMainMenuFromGame();
                        });
                    }, 100);
                    return;
                }

                // Otherwise move to next level (1→2→3→4→5)
                hardModeProgress++;
                setTimeout(() => {
                    document.getElementById('gameContainer').style.display = 'none';
                    document.getElementById('characterSelect').style.display = 'block';
                    selectedLevel = hardModeProgress;
                }, 500);
                return;
            }

            setTimeout(() => {
                showGameAlert('🎉 УРОВЕНЬ ПРОЙДЕН!\n\nОтличная работа!', 'Уровень пройден').then(() => backToMainMenuFromGame());
            }, 100);
        }
        function backToMainMenuFromGame() {
            gameState = 'menu';
            stopMusic();
            stopAllHtmlMusic(true);
            document.getElementById('gameContainer').style.display = 'none';
            document.getElementById('mainMenu').style.display = 'flex';
            document.getElementById('bossHealth').style.display = 'none';
            document.getElementById('miniBossHealth').style.display = 'none';
            tutorialTextElement.style.display = 'none';

            // Reset HoTRoD cutscene flags
            hotrodIntroPending = false;
            hotrodCutscene.active = false;
            hotrodCutscene.stage = 0;
            hotrodCutscene.stageT = 0;

            // Safety: ensure pyro aura is off when returning to menu
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;
            if (selectedCharacter === 'ammo') for (const type in weapons) if (weapons[type].originalAmmo !== undefined) { weapons[type].ammo = weapons[type].originalAmmo; delete weapons[type].originalAmmo; }
            try {
                if (musicEnabled) menuMusic.play();
            } catch (e) {}
        }

        let lastTime = 0;
        const targetFPS = 60;
        const frameDelay = 1000 / targetFPS;

        function gameLoop(currentTime = 0) {
            const deltaTime = currentTime - lastTime;

            if (deltaTime >= frameDelay) {
                lastTime = currentTime - (deltaTime % frameDelay);
                update();
                draw();
            }

            requestAnimationFrame(gameLoop);
        }
        gameLoop();
