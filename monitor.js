
import fs from 'node:fs/promises';
import { fetchByActress } from './src/fanza-client.js';

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = 'monitor-state.json';
const RELEASE_STATE_FILE = 'release-state.json';

const actresses = JSON.parse(
  await fs.readFile('monitor-actresses.json', 'utf8')
);

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

const previous = await readJson(STATE_FILE, null);
const state = previous ?? {};

const releaseState = await readJson(RELEASE_STATE_FILE, null);
const firstReleaseRun = releaseState === null;

const releaseRecords = releaseState ?? {
  lastCheckedDate: null,
  notifiedIds: []
};

const notifiedReleases = new Set(releaseRecords.notifiedIds);
const todayJST = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());

let newCount = 0;
let failed = 0;
const releaseCandidates = new Map();

function getReleaseDate(work) {
  if (!work.deliveryStartAt) return null;

  const date = new Date(work.deliveryStartAt);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function workUrl(id) {
  return `https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=${encodeURIComponent(id)}/`;
}

async function sendDiscord(payload) {
  if (!WEBHOOK) throw new Error('Missing Discord webhook');

  const response = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Discord HTTP ${response.status}`);
  }
}

async function notify(actress, work) {
  const embed = {
    title: work.title || work.id,
    url: workUrl(work.id),
    description: `演员：${actress.name}\n作品 ID：${work.id}`,
    color: 0xE91E63,
    fields: [{
      name: 'FANZA 日期',
      value: work.deliveryStartAt
        ? new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }).format(new Date(work.deliveryStartAt))
        : '未知',
      inline: true
    }],
    ...(work.packageImage?.largeUrl
      ? { image: { url: work.packageImage.largeUrl } }
      : {})
  };

  await sendDiscord({ embeds: [embed] });
}

for (const actress of actresses) {
  try {
    const result = await fetchByActress(actress.id, 100);
    const works = result.contents || [];

    const oldIds = new Set(state[actress.id] || []);
    const currentIds = new Set(works.map(work => work.id));

    const isNewActress = !Object.hasOwn(state, actress.id);

    const newWorks = isNewActress
      ? []
      : works.filter(work => !oldIds.has(work.id));

    for (const work of newWorks.reverse()) {
      await notify(actress, work);
      newCount++;
      console.log(`Notified: ${actress.name} - ${work.id}`);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    state[actress.id] = [
      ...new Set([...oldIds, ...currentIds])
    ];

    for (const work of works) {
      const date = getReleaseDate(work);
      if (!date) continue;

      const existing = releaseCandidates.get(work.id);

      if (existing) {
        if (!existing.actresses.includes(actress.name)) {
          existing.actresses.push(actress.name);
        }
      } else {
        releaseCandidates.set(work.id, {
          id: work.id,
          title: work.title || work.id,
          date,
          actresses: [actress.name]
        });
      }
    }

    console.log(
      `${actress.name}: ${works.length} works, ${newWorks.length} new`
    );
  } catch (error) {
    failed++;
    console.error(`${actress.name}: ${error.message}`);
  }

  await new Promise(resolve => setTimeout(resolve, 500));
}

// Save the original monitoring records.
await fs.writeFile(
  STATE_FILE,
  JSON.stringify(state, null, 2) + '\n'
);

// Only process release notifications after every actress check succeeds.
if (failed === 0) {
  if (firstReleaseRun) {
    // Establish a baseline without sending historical release alerts.
    for (const work of releaseCandidates.values()) {
      if (work.date <= todayJST) {
        notifiedReleases.add(work.id);
      }
    }

    releaseRecords.lastCheckedDate = todayJST;
    console.log('Release baseline established.');
  } else {
    const dueWorks = [...releaseCandidates.values()]
      .filter(work =>
        work.date <= todayJST &&
        work.date > releaseRecords.lastCheckedDate &&
        !notifiedReleases.has(work.id)
      )
      .sort((a, b) =>
        a.date.localeCompare(b.date) ||
        a.id.localeCompare(b.id)
      );

    if (dueWorks.length > 0) {
      const lines = dueWorks.map((work, index) => {
        const title = work.title.length > 90
          ? work.title.slice(0, 87) + '...'
          : work.title;

        return `${index + 1}. **${work.actresses.join('、')}**\n[${title}](${workUrl(work.id)})\n配信日期：${work.date}`;
      });

      // Discord embeds have a 4096-character description limit.
      const chunks = [];
      let chunk = '';

      for (const line of lines) {
        if (chunk && (chunk.length + line.length + 2 > 3800)) {
          chunks.push(chunk);
          chunk = '';
        }
        chunk += (chunk ? '\n\n' : '') + line;
      }

      if (chunk) chunks.push(chunk);

      // All chunks are embeds within one Discord message, up to 10 embeds.
      if (chunks.length > 10) {
        throw new Error('Too many release items for one Discord message');
      }

      await sendDiscord({
        embeds: chunks.map((description, index) => ({
          title: index === 0
            ? `FANZA 正式配信汇总｜${todayJST}`
            : '正式配信汇总（续）',
          description,
          color: 0x5865F2
        }))
      });

      for (const work of dueWorks) {
        notifiedReleases.add(work.id);
      }

      console.log(`Release digest sent: ${dueWorks.length} works`);
    } else {
      console.log('Release digest: no new releases');
    }

    releaseRecords.lastCheckedDate = todayJST;
  }

  releaseRecords.notifiedIds = [...notifiedReleases];

  await fs.writeFile(
    RELEASE_STATE_FILE,
    JSON.stringify(releaseRecords, null, 2) + '\n'
  );
}

console.log(`Finished. Notifications: ${newCount}; failures: ${failed}`);

if (failed > 0) {
  process.exitCode = 1;
}
