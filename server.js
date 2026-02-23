/*
	Roblox API Proxy Server
	
	Host on Render.com (free):
	1. Push this to a GitHub repo
	2. Go to render.com → New → Web Service
	3. Connect your GitHub repo
	4. Settings: Runtime = Node, Build Command = npm install, Start Command = node server.js
	5. Pick the FREE plan
	6. Deploy — copy your URL (e.g. https://your-proxy.onrender.com)
	7. Paste that URL into PlaytimeService.lua
	
	Note: Free Render services sleep after 15 min of no requests.
	They wake up on the next request (~30 sec cold start). This is fine
	because scans only happen on player join.
*/

const express = require("express");
const app = express();

app.use(express.json());

// ─── Rate Limiting ───────────────────────────────────────
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 60;

function checkRateLimit(ip) {
	const now = Date.now();
	const entry = rateLimit.get(ip);
	if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
		rateLimit.set(ip, { start: now, count: 1 });
		return true;
	}
	entry.count++;
	return entry.count <= RATE_LIMIT_MAX;
}

// ─── Allowed Roblox Domains ──────────────────────────────
const ALLOWED_DOMAINS = [
	"badges.roblox.com",
	"inventory.roblox.com",
	"games.roblox.com",
	"thumbnails.roblox.com",
	"users.roblox.com",
	"catalog.roblox.com",
];

// ─── Health Check ────────────────────────────────────────
app.get("/", (req, res) => {
	res.json({ status: "ok", service: "roblox-playtime-proxy", uptime: process.uptime() });
});

// ─── Keep Alive Endpoint (optional: ping from external cron) ──
app.get("/ping", (req, res) => {
	res.json({ pong: true });
});

// ─── Generic Proxy ───────────────────────────────────────
app.get("/proxy", async (req, res) => {
	if (!checkRateLimit(req.ip)) {
		return res.status(429).json({ error: "Rate limited" });
	}

	const targetUrl = req.query.url;
	if (!targetUrl) {
		return res.status(400).json({ error: "Missing 'url' query parameter" });
	}

	try {
		const parsed = new URL(targetUrl);
		if (!ALLOWED_DOMAINS.includes(parsed.hostname)) {
			return res.status(403).json({ error: "Domain not allowed: " + parsed.hostname });
		}
	} catch {
		return res.status(400).json({ error: "Invalid URL" });
	}

	try {
		const response = await fetch(targetUrl, {
			headers: { "Accept": "application/json", "User-Agent": "RobloxProxy/1.0" },
		});
		const data = await response.json();
		res.json(data);
	} catch (err) {
		res.status(500).json({ error: "Proxy fetch failed", details: err.message });
	}
});

// ─── User Badges for a Specific Game ─────────────────────
// GET /user-badges?userId=123&universeId=456
app.get("/user-badges", async (req, res) => {
	if (!checkRateLimit(req.ip)) {
		return res.status(429).json({ error: "Rate limited" });
	}

	const { userId, universeId } = req.query;
	if (!userId || !universeId) {
		return res.status(400).json({ error: "Missing userId or universeId" });
	}

	try {
		// Get all badges for this universe (max 3 pages)
		let allBadges = [];
		let cursor = "";

		for (let page = 0; page < 3; page++) {
			const badgeUrl = `https://badges.roblox.com/v1/universes/${universeId}/badges?limit=100&sortOrder=Asc${cursor ? "&cursor=" + cursor : ""}`;
			const badgeRes = await fetch(badgeUrl, { headers: { "Accept": "application/json" } });
			const badgeData = await badgeRes.json();

			if (badgeData.data) allBadges = allBadges.concat(badgeData.data);
			if (badgeData.nextPageCursor) cursor = badgeData.nextPageCursor;
			else break;
		}

		// Check which badges the user has earned
		const badgeIds = allBadges.map(b => b.id);
		let earnedBadges = [];

		for (let i = 0; i < badgeIds.length; i += 100) {
			const batch = badgeIds.slice(i, i + 100);
			const checkUrl = `https://badges.roblox.com/v1/users/${userId}/badges/awarded-dates?badgeIds=${batch.join(",")}`;
			const checkRes = await fetch(checkUrl, { headers: { "Accept": "application/json" } });
			const checkData = await checkRes.json();
			if (checkData.data) earnedBadges = earnedBadges.concat(checkData.data);
		}

		// Merge
		const earnedMap = new Map(earnedBadges.map(e => [e.badgeId, e.awardedDate]));

		const result = allBadges.map(badge => ({
			id: badge.id,
			name: badge.name,
			earned: earnedMap.has(badge.id),
			earnedDate: earnedMap.get(badge.id) || null,
			rarityPct: badge.statistics?.winRatePercentage || null,
			awardedCount: badge.statistics?.awardedCount || 0,
		}));

		res.json({
			universeId: parseInt(universeId),
			userId: parseInt(userId),
			totalBadges: allBadges.length,
			earnedCount: earnedBadges.length,
			badges: result,
		});
	} catch (err) {
		res.status(500).json({ error: "Failed to fetch badges", details: err.message });
	}
});

// ─── Batch Scan Multiple Games ───────────────────────────
// POST /scan-games { userId: 123, universeIds: [456, 789, ...] }
app.post("/scan-games", async (req, res) => {
	if (!checkRateLimit(req.ip)) {
		return res.status(429).json({ error: "Rate limited" });
	}

	const { userId, universeIds } = req.body;
	if (!userId || !universeIds || !Array.isArray(universeIds)) {
		return res.status(400).json({ error: "Missing userId or universeIds array" });
	}

	const limitedIds = universeIds.slice(0, 20);
	const results = [];

	for (const universeId of limitedIds) {
		try {
			// Get badges
			const badgeUrl = `https://badges.roblox.com/v1/universes/${universeId}/badges?limit=100&sortOrder=Asc`;
			const badgeRes = await fetch(badgeUrl, { headers: { "Accept": "application/json" } });
			const badgeData = await badgeRes.json();
			const allBadges = badgeData.data || [];

			if (allBadges.length === 0) {
				results.push({ universeId, totalBadges: 0, earnedCount: 0, earnedBadges: [], firstEarned: null, lastEarned: null });
				continue;
			}

			// Check earned
			const badgeIds = allBadges.map(b => b.id);
			const checkUrl = `https://badges.roblox.com/v1/users/${userId}/badges/awarded-dates?badgeIds=${badgeIds.join(",")}`;
			const checkRes = await fetch(checkUrl, { headers: { "Accept": "application/json" } });
			const checkData = await checkRes.json();
			const earned = checkData.data || [];

			// Date range
			let firstEarned = null, lastEarned = null;
			for (const e of earned) {
				const date = new Date(e.awardedDate);
				if (!firstEarned || date < new Date(firstEarned)) firstEarned = e.awardedDate;
				if (!lastEarned || date > new Date(lastEarned)) lastEarned = e.awardedDate;
			}

			// Build earned badge list with rarity
			const earnedBadges = earned.map(e => {
				const info = allBadges.find(b => b.id === e.badgeId);
				return {
					id: e.badgeId,
					name: info?.name || "Unknown",
					earnedDate: e.awardedDate,
					rarityPct: info?.statistics?.winRatePercentage || null,
					awardedCount: info?.statistics?.awardedCount || 0,
				};
			});

			results.push({ universeId, totalBadges: allBadges.length, earnedCount: earned.length, earnedBadges, firstEarned, lastEarned });
		} catch (err) {
			results.push({ universeId, error: err.message });
		}

		// Small delay to be nice to Roblox
		await new Promise(r => setTimeout(r, 200));
	}

	res.json({ userId: parseInt(userId), games: results });
});

// ─── Game Info (names, icons, etc) ───────────────────────
// GET /game-info?universeIds=123,456,789
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
			created: g.created,
			updated: g.updated,
			icon: thumbMap.get(g.id) || null,
		}));

		res.json({ games });
	} catch (err) {
		res.status(500).json({ error: "Failed to fetch game info", details: err.message });
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
	console.log(`Roblox Proxy running on port ${PORT}`);
});
