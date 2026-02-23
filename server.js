/*
	Roblox API Proxy Server — v2
	
	Fetches ALL badges a user has earned across EVERY game.
	Groups them by game automatically. No hardcoded game list needed.
	
	Deploy on Render.com (free tier).
*/

const express = require("express");
const app = express();

app.use(express.json());

// ─── Rate Limiting ───────────────────────────────────────
const rateLimit = new Map();
function checkRateLimit(ip) {
	const now = Date.now();
	const entry = rateLimit.get(ip);
	if (!entry || now - entry.start > 60000) {
		rateLimit.set(ip, { start: now, count: 1 });
		return true;
	}
	entry.count++;
	return entry.count <= 30;
}

// ─── Health ──────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "roblox-playtime-proxy-v2" }));
app.get("/ping", (req, res) => res.json({ pong: true }));

// ─── MAIN ENDPOINT: Get ALL badges for a user ───────────
// GET /all-badges?userId=12345
app.get("/all-badges", async (req, res) => {
	if (!checkRateLimit(req.ip)) {
		return res.status(429).json({ error: "Rate limited" });
	}

	const { userId } = req.query;
	if (!userId) {
		return res.status(400).json({ error: "Missing userId" });
	}

	try {
		// Paginate through ALL user badges
		let allBadges = [];
		let cursor = "";
		let pages = 0;
		const MAX_PAGES = 20; // up to 2000 badges

		while (pages < MAX_PAGES) {
			const url = `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Asc${cursor ? "&cursor=" + cursor : ""}`;
			const resp = await fetch(url, { headers: { "Accept": "application/json" } });
			const data = await resp.json();

			if (data.data) {
				allBadges = allBadges.concat(data.data);
			}

			if (data.nextPageCursor) {
				cursor = data.nextPageCursor;
				pages++;
			} else {
				break;
			}
		}

		// Group badges by awarding universe (game)
		const gameMap = new Map();

		for (const badge of allBadges) {
			// Try every possible field for universe ID
			const universe = badge.awarder?.id || badge.awardingUniverse?.id || null;

			if (!universe) continue;

			if (!gameMap.has(universe)) {
				gameMap.set(universe, {
					universeId: universe,
					name: null, // Will resolve below
					badges: [],
				});
			}

			gameMap.get(universe).badges.push({
				id: badge.id,
				name: badge.name,
				rarityPct: badge.statistics?.winRatePercentage ?? badge.statistics?.pastDayAwardedCount ?? null,
				awardedCount: badge.statistics?.awardedCount || 0,
			});
		}

		// Resolve game names via games API (batch by 50)
		const universeIds = Array.from(gameMap.keys());
		for (let i = 0; i < universeIds.length; i += 50) {
			const batch = universeIds.slice(i, i + 50);
			try {
				const gamesUrl = `https://games.roblox.com/v1/games?universeIds=${batch.join(",")}`;
				const gamesResp = await fetch(gamesUrl, { headers: { "Accept": "application/json" } });
				const gamesData = await gamesResp.json();
				if (gamesData.data) {
					for (const game of gamesData.data) {
						if (gameMap.has(game.id)) {
							gameMap.get(game.id).name = game.name;
						}
					}
				}
			} catch (e) { /* skip batch */ }
		}

		// Fill in any still-missing names
		for (const [id, data] of gameMap) {
			if (!data.name) data.name = `Game ${id}`;
		}

		// Get awarded dates for timing info
		const allBadgeIds = allBadges.map(b => b.id);
		const awardedDates = new Map();

		for (let i = 0; i < allBadgeIds.length; i += 100) {
			const batch = allBadgeIds.slice(i, i + 100);
			try {
				const dateUrl = `https://badges.roblox.com/v1/users/${userId}/badges/awarded-dates?badgeIds=${batch.join(",")}`;
				const dateResp = await fetch(dateUrl, { headers: { "Accept": "application/json" } });
				const dateData = await dateResp.json();
				if (dateData.data) {
					for (const entry of dateData.data) {
						awardedDates.set(entry.badgeId, entry.awardedDate);
					}
				}
			} catch (e) { /* skip batch on error */ }
		}

		// Build final result per game
		const games = [];

		for (const [universeId, gameData] of gameMap) {
			let firstEarned = null;
			let lastEarned = null;

			const enrichedBadges = gameData.badges.map(badge => {
				const earnedDate = awardedDates.get(badge.id) || null;
				if (earnedDate) {
					const d = new Date(earnedDate);
					if (!firstEarned || d < new Date(firstEarned)) firstEarned = earnedDate;
					if (!lastEarned || d > new Date(lastEarned)) lastEarned = earnedDate;
				}
				return { ...badge, earnedDate };
			});

			games.push({
				universeId,
				name: gameData.name,
				earnedCount: enrichedBadges.length,
				earnedBadges: enrichedBadges,
				firstEarned,
				lastEarned,
			});
		}

		// Sort by badge count descending
		games.sort((a, b) => b.earnedCount - a.earnedCount);

		res.json({
			userId: parseInt(userId),
			totalBadges: allBadges.length,
			totalGames: games.length,
			games,
		});
	} catch (err) {
		console.error("Error fetching badges:", err);
		res.status(500).json({ error: "Failed to fetch badges", details: err.message });
	}
});

// ─── Game Info (names, icons) ────────────────────────────
app.get("/game-info", async (req, res) => {
	if (!checkRateLimit(req.ip)) {
		return res.status(429).json({ error: "Rate limited" });
	}

	const { universeIds } = req.query;
	if (!universeIds) {
		return res.status(400).json({ error: "Missing universeIds" });
	}

	try {
		const infoUrl = `https://games.roblox.com/v1/games?universeIds=${universeIds}`;
		const infoRes = await fetch(infoUrl, { headers: { "Accept": "application/json" } });
		const infoData = await infoRes.json();

		const thumbUrl = `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds}&returnPolicy=PlaceHolder&size=128x128&format=Png&isCircular=false`;
		const thumbRes = await fetch(thumbUrl, { headers: { "Accept": "application/json" } });
		const thumbData = await thumbRes.json();
		const thumbMap = new Map((thumbData.data || []).map(t => [t.targetId, t.imageUrl]));

		const games = (infoData.data || []).map(g => ({
			universeId: g.id,
			name: g.name,
			playing: g.playing,
			visits: g.visits,
			icon: thumbMap.get(g.id) || null,
		}));

		res.json({ games });
	} catch (err) {
		res.status(500).json({ error: "Failed to fetch game info", details: err.message });
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
	console.log(`Roblox Proxy v2 running on port ${PORT}`);
});
