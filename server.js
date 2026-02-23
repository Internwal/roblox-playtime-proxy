/*
	Connection Finder Proxy v2
	
	Finds shortest friend-chain between two Roblox players.
	Bidirectional BFS, max 6 degrees.
	
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
	return entry.count <= 20;
}

// ─── Roblox API helpers ──────────────────────────────────
async function getFriends(userId) {
	try {
		const resp = await fetch(
			`https://friends.roblox.com/v1/users/${userId}/friends?limit=200`,
			{ headers: { Accept: "application/json" } }
		);
		if (!resp.ok) return [];
		const data = await resp.json();
		return (data.data || []).map(f => f.id);
	} catch { return []; }
}

async function getUserInfo(userId) {
	try {
		const resp = await fetch(
			`https://users.roblox.com/v1/users/${userId}`,
			{ headers: { Accept: "application/json" } }
		);
		if (!resp.ok) return { id: userId, name: "Unknown", displayName: "Unknown" };
		const d = await resp.json();
		return { id: d.id, name: d.name, displayName: d.displayName };
	} catch { return { id: userId, name: "Unknown", displayName: "Unknown" }; }
}

async function getAvatars(userIds) {
	if (!userIds.length) return {};
	try {
		const resp = await fetch(
			`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(",")}&size=150x150&format=Png&isCircular=false`,
			{ headers: { Accept: "application/json" } }
		);
		const data = await resp.json();
		const m = {};
		for (const e of (data.data || [])) m[e.targetId] = e.imageUrl;
		return m;
	} catch { return {}; }
}

// ─── Reconstruct path from BFS parent maps ──────────────
function reconstructPath(meetingId, cameFromSideA, parentA, parentB) {
	// Trace from meeting point back to A
	const toA = [];
	let cur = cameFromSideA; // the node on A's side that found meetingId
	while (cur !== null) {
		toA.unshift(cur);
		cur = parentA.get(cur) ?? null;
	}
	// toA is now [userA, ..., cameFromSideA]

	// Trace from meeting point back to B  
	const toB = [];
	cur = meetingId;
	while (cur !== null) {
		toB.push(cur);
		cur = parentB.get(cur) ?? null;
	}
	// toB is now [meetingId, ..., userB]

	return [...toA, ...toB];
}

// ─── Health ──────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "connection-finder-proxy" }));
app.get("/ping", (req, res) => res.json({ pong: true }));

// ─── Get friends ─────────────────────────────────────────
app.get("/friends", async (req, res) => {
	if (!checkRateLimit(req.ip)) return res.status(429).json({ error: "Rate limited" });
	const { userId } = req.query;
	if (!userId) return res.status(400).json({ error: "Missing userId" });
	const friends = await getFriends(parseInt(userId));
	res.json({ userId: parseInt(userId), friends, count: friends.length });
});

// ─── MAIN: Find connection ───────────────────────────────
// GET /find-connection?userA=123&userB=456
app.get("/find-connection", async (req, res) => {
	if (!checkRateLimit(req.ip)) return res.status(429).json({ error: "Rate limited" });

	const idA = parseInt(req.query.userA);
	const idB = parseInt(req.query.userB);
	if (!idA || !idB) return res.status(400).json({ error: "Missing userA or userB" });

	// Same person
	if (idA === idB) {
		const info = await getUserInfo(idA);
		const av = await getAvatars([idA]);
		return res.json({
			found: true, degree: 0,
			path: [{ ...info, avatar: av[idA] || null }],
			message: "Same person!",
		});
	}

	console.log(`Searching connection: ${idA} <-> ${idB}`);
	const startTime = Date.now();

	const MAX_DEGREE = 6;
	const MAX_EXPAND = 40; // max users to expand per layer per side

	// parentA maps userId -> the userId that discovered it (from A's side)
	// parentB maps userId -> the userId that discovered it (from B's side)
	const parentA = new Map();
	const parentB = new Map();
	parentA.set(idA, null);
	parentB.set(idB, null);

	let frontierA = [idA];
	let frontierB = [idB];

	for (let step = 0; step < MAX_DEGREE; step++) {
		// Pick the smaller frontier to expand
		const expandingA = frontierA.length <= frontierB.length;
		const frontier = expandingA ? frontierA : frontierB;
		const ownParent = expandingA ? parentA : parentB;
		const otherParent = expandingA ? parentB : parentA;

		const toExpand = frontier.slice(0, MAX_EXPAND);
		console.log(`  Step ${step + 1}: expanding ${toExpand.length} from ${expandingA ? "A" : "B"} side`);

		const nextFrontier = [];

		// Fetch friends in parallel batches of 10
		for (let i = 0; i < toExpand.length; i += 10) {
			const batch = toExpand.slice(i, i + 10);
			const results = await Promise.all(batch.map(uid => getFriends(uid)));

			for (let j = 0; j < batch.length; j++) {
				const expandedUser = batch[j];
				const friends = results[j];

				for (const friendId of friends) {
					// Check if this friend exists on the OTHER side → connection found
					if (otherParent.has(friendId)) {
						console.log(`  Connection found via ${friendId}! (${Date.now() - startTime}ms)`);

						// Reconstruct the path
						let pathIds;
						if (expandingA) {
							// expandedUser is on A's side, friendId is on B's side
							// Trace A -> ... -> expandedUser
							const toAPath = [];
							let c = expandedUser;
							while (c !== null) {
								toAPath.unshift(c);
								c = parentA.get(c) ?? null;
							}
							// Trace friendId -> ... -> B
							const toBPath = [];
							c = friendId;
							while (c !== null) {
								toBPath.push(c);
								c = parentB.get(c) ?? null;
							}
							pathIds = [...toAPath, ...toBPath];
						} else {
							// expandedUser is on B's side, friendId is on A's side
							// Trace A -> ... -> friendId
							const toAPath = [];
							let c = friendId;
							while (c !== null) {
								toAPath.unshift(c);
								c = parentA.get(c) ?? null;
							}
							// Trace expandedUser -> ... -> B
							const toBPath = [];
							c = expandedUser;
							while (c !== null) {
								toBPath.push(c);
								c = parentB.get(c) ?? null;
							}
							pathIds = [...toAPath, ...toBPath];
						}

						// Get user info + avatars for the path
						const infos = await Promise.all(pathIds.map(id => getUserInfo(id)));
						const avatars = await getAvatars(pathIds);
						const path = infos.map(u => ({
							...u,
							avatar: avatars[u.id] || null,
						}));

						return res.json({
							found: true,
							degree: pathIds.length - 1,
							path,
						});
					}

					// Not visited yet — add to frontier
					if (!ownParent.has(friendId)) {
						ownParent.set(friendId, expandedUser);
						nextFrontier.push(friendId);
					}
				}
			}
		}

		if (expandingA) {
			frontierA = nextFrontier;
		} else {
			frontierB = nextFrontier;
		}

		if (nextFrontier.length === 0) break;
	}

	// Not found
	console.log(`  No connection found (${Date.now() - startTime}ms)`);
	const [infoA, infoB] = await Promise.all([getUserInfo(idA), getUserInfo(idB)]);
	const avatars = await getAvatars([idA, idB]);

	res.json({
		found: false, degree: -1, path: [],
		userA: { ...infoA, avatar: avatars[idA] || null },
		userB: { ...infoB, avatar: avatars[idB] || null },
		message: `No connection found within ${MAX_DEGREE} degrees`,
	});
});

// ─── User info endpoint ──────────────────────────────────
app.get("/user-info", async (req, res) => {
	if (!checkRateLimit(req.ip)) return res.status(429).json({ error: "Rate limited" });
	const { userId } = req.query;
	if (!userId) return res.status(400).json({ error: "Missing userId" });
	const info = await getUserInfo(parseInt(userId));
	const av = await getAvatars([parseInt(userId)]);
	res.json({ ...info, avatar: av[parseInt(userId)] || null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
	console.log(`Connection Finder Proxy running on port ${PORT}`);
});
