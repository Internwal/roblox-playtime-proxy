/*
	Connection Finder Proxy — Chain Search
	BFS through friend lists to find the chain connecting two players.
	Every node in the chain gets proper name + avatar.
	Deploy on Render.com.
*/
const express = require("express");
const app = express();
app.use(express.json());

const rateLimit = new Map();
function rl(ip) {
	const now = Date.now(), e = rateLimit.get(ip);
	if (!e || now - e.s > 60000) { rateLimit.set(ip, { s: now, c: 1 }); return true; }
	return ++e.c <= 25;
}

async function getFriendIds(userId) {
	try {
		const r = await fetch(`https://friends.roblox.com/v1/users/${userId}/friends`,
			{ headers: { Accept: "application/json" } });
		if (!r.ok) return [];
		const d = await r.json();
		return (d.data || []).map(f => f.id);
	} catch { return []; }
}

async function getUsersBatch(ids) {
	// POST to users API to get names in batch
	if (!ids.length) return {};
	const out = {};
	try {
		const r = await fetch("https://users.roblox.com/v1/users", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ userIds: ids.slice(0, 100), excludeBannedUsers: false }),
		});
		const d = await r.json();
		for (const u of (d.data || [])) out[u.id] = { id: u.id, name: u.name, displayName: u.displayName };
	} catch {}
	return out;
}

async function getAvatarsBatch(ids) {
	if (!ids.length) return {};
	const out = {};
	try {
		const r = await fetch(
			`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.slice(0,100).join(",")}&size=150x150&format=Png&isCircular=false`,
			{ headers: { Accept: "application/json" } });
		const d = await r.json();
		for (const e of (d.data || [])) out[e.targetId] = e.imageUrl;
	} catch {}
	return out;
}

app.get("/", (_, res) => res.json({ status: "ok" }));
app.get("/ping", (_, res) => res.json({ pong: true }));

/*
	GET /find-chain?userA=123&userB=456
	Bidirectional BFS, max 6 degrees, 30 users expanded per layer.
	Returns { found, degree, chain: [{id,name,displayName,avatar}] }
*/
app.get("/find-chain", async (req, res) => {
	if (!rl(req.ip)) return res.status(429).json({ error: "Rate limited" });

	const idA = parseInt(req.query.userA);
	const idB = parseInt(req.query.userB);
	if (!idA || !idB) return res.status(400).json({ error: "Need userA and userB" });
	if (idA === idB) return res.json({ found: true, degree: 0, chain: [idA] });

	console.log(`Chain search: ${idA} <-> ${idB}`);
	const t0 = Date.now();

	const MAX_DEGREE = 6;
	const MAX_EXPAND = 30;

	const parentA = new Map(); // userId -> parentId from A side
	const parentB = new Map(); // userId -> parentId from B side
	parentA.set(idA, null);
	parentB.set(idB, null);

	let frontA = [idA], frontB = [idB];

	for (let step = 0; step < MAX_DEGREE; step++) {
		const useA = frontA.length <= frontB.length;
		const front = useA ? frontA : frontB;
		const own = useA ? parentA : parentB;
		const other = useA ? parentB : parentA;
		const expand = front.slice(0, MAX_EXPAND);

		console.log(`  Step ${step+1}: expanding ${expand.length} from ${useA?"A":"B"}`);

		const next = [];

		// Fetch in parallel batches of 8
		for (let i = 0; i < expand.length; i += 8) {
			const batch = expand.slice(i, i + 8);
			const results = await Promise.all(batch.map(getFriendIds));

			for (let j = 0; j < batch.length; j++) {
				const uid = batch[j];
				for (const fid of results[j]) {
					if (other.has(fid)) {
						// Found connection! Build chain.
						console.log(`  Connected via ${fid} (${Date.now()-t0}ms)`);

						// Trace from A to fid
						const halfA = [];
						if (useA) {
							// uid is A-side, fid is B-side
							let c = uid; while (c !== null) { halfA.unshift(c); c = parentA.get(c) ?? null; }
							halfA.push(fid);
							const halfB = [];
							c = parentB.get(fid) ?? null;
							while (c !== null) { halfB.push(c); c = parentB.get(c) ?? null; }
							var chainIds = [...halfA, ...halfB];
						} else {
							// uid is B-side, fid is A-side
							let c = fid; while (c !== null) { halfA.unshift(c); c = parentA.get(c) ?? null; }
							halfA.push(uid);
							const halfB = [];
							c = parentB.get(uid) ?? null;
							while (c !== null) { halfB.push(c); c = parentB.get(c) ?? null; }
							var chainIds = [...halfA, ...halfB];
						}

						// Deduplicate consecutive
						const clean = [chainIds[0]];
						for (let k = 1; k < chainIds.length; k++) {
							if (chainIds[k] !== chainIds[k-1]) clean.push(chainIds[k]);
						}

						// Resolve names + avatars for every person in chain
						const [users, avatars] = await Promise.all([
							getUsersBatch(clean),
							getAvatarsBatch(clean),
						]);

						const chain = clean.map(id => ({
							id,
							name: users[id]?.name || `User${id}`,
							displayName: users[id]?.displayName || `User${id}`,
							avatar: avatars[id] || null,
						}));

						return res.json({ found: true, degree: clean.length - 1, chain });
					}

					if (!own.has(fid)) {
						own.set(fid, uid);
						next.push(fid);
					}
				}
			}
		}

		if (useA) frontA = next; else frontB = next;
		if (!next.length) break;
	}

	console.log(`  No chain found (${Date.now()-t0}ms)`);
	res.json({ found: false, degree: -1, chain: [] });
});

// User info endpoint
app.get("/user-info", async (req, res) => {
	if (!rl(req.ip)) return res.status(429).json({ error: "Rate limited" });
	const id = parseInt(req.query.userId);
	if (!id) return res.status(400).json({ error: "Need userId" });
	const u = await getUsersBatch([id]);
	const a = await getAvatarsBatch([id]);
	res.json({ id, name: u[id]?.name||"Unknown", displayName: u[id]?.displayName||"Unknown", avatar: a[id]||null });
});

app.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("Connection Finder running"));
