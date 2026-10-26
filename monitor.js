
import fs from 'node:fs/promises';
import { fetchByActress } from './src/fanza-client.js';

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = 'monitor-state.json';

const actresses = JSON.parse(
  await fs.readFile('monitor-actresses.json', 'utf8')
);

let previous = null;

try {
  previous = JSON.parse(
    await fs.readFile(STATE_FILE, 'utf8')
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const firstRun = previous === null;
const state = previous ?? {};
let newCount = 0;
let failed = 0;

async function notify(actress, work) {
  if (!WEBHOOK) throw new Error('Missing Discord webhook');

  const embed = {
    title: work.title || work.id,
    url: `https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=${encodeURIComponent(work.id)}/`,
    description: `演员：${actress.name}\n作品 ID：${work.id}`,
    color: 0xE91E63,
    fields: [
      {
       {
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
}
      }
    ],
    ...(work.packageImage?.largeUrl
      ? { image: { url: work.packageImage.largeUrl } }
      : {})
  };

  const response = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });

  if (!response.ok) {
    throw new Error(`Discord HTTP ${response.status}`);
  }
}

for (const actress of actresses) {
  try {
    // Check the 100 most recently sorted works
    const result = await fetchByActress(actress.id, 100);
    const works = result.contents || [];

    const oldIds = new Set(state[actress.id] || []);
    const currentIds = new Set(works.map(work => work.id));

    const newWorks = firstRun
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

    console.log(
      `${actress.name}: ${works.length} works, ${newWorks.length} new`
    );
  } catch (error) {
    failed++;
    console.error(`${actress.name}: ${error.message}`);
  }

  await new Promise(resolve => setTimeout(resolve, 500));
}

if (firstRun && failed === 0) {
  console.log('Baseline established. No historical notifications sent.');
}

await fs.writeFile(
  STATE_FILE,
  JSON.stringify(state, null, 2) + '\n'
);

console.log(`Finished. Notifications: ${newCount}; failures: ${failed}`);

if (failed > 0) {
  process.exitCode = 1;
}
