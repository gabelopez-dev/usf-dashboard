const https = require('https');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function queryNotion() {
  let results = [];
  let cursor = undefined;
  do {
    const bodyObj = { page_size: 100 };
    if (cursor) bodyObj.start_cursor = cursor;
    const body = JSON.stringify(bodyObj);
    const res = await httpsRequest({
      hostname: 'api.notion.com',
      path: `/v1/databases/${NOTION_DB_ID}/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
    if (res.body.results) results = results.concat(res.body.results);
    cursor = res.body.has_more ? res.body.next_cursor : undefined;
  } while (cursor);
  return results;
}

function getProp(page, propName, type) {
  const prop = page.properties?.[propName];
  if (!prop) return null;
  switch(type) {
    case 'select': return prop.select?.name || null;
    case 'checkbox': return prop.checkbox || false;
    case 'number': return prop.number || 0;
    case 'date': return prop.date?.start || null;
    case 'title': return prop.title?.[0]?.text?.content || null;
    case 'text': return prop.rich_text?.[0]?.text?.content || null;
    default: return null;
  }
}

async function getFileSHA() {
  const [owner, repo] = GITHUB_REPO.split('/');
  const res = await httpsRequest({
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/contents/data.json`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'USF-Dashboard-Sync'
    }
  });
  return res.body.sha || null;
}

async function writeToGitHub(content, sha) {
  const [owner, repo] = GITHUB_REPO.split('/');
  const encoded = Buffer.from(content).toString('base64');
  const bodyObj = {
    message: 'Auto-update data.json from Notion',
    content: encoded,
    sha: sha
  };
  const body = JSON.stringify(bodyObj);
  const res = await httpsRequest({
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/contents/data.json`,
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'USF-Dashboard-Sync'
    }
  }, body);
  return res;
}

async function main() {
  console.log('Fetching Notion data...');
  const records = await queryNotion();
  console.log(`Found ${records.length} total records`);

  // Active statuses
  const activeStatuses = [
    'Recruiter Review (WIP)', 'Sourced', 'Screened', 'HM Review',
    'Interview Stage', 'Offer Stage', 'Pre-boarding', 'Backlog',
    'Targeted', 'Posted', 'Active (WIP)'
  ];

  const activeRecords = records.filter(r => {
    const status = getProp(r, 'Status', 'select');
    return activeStatuses.includes(status);
  });

  console.log(`Active records: ${activeRecords.length}`);

  const recruiterNames = ['Katherine', 'Rebecca', 'John', 'Gabriel', 'Tameka', 'JKB'];
  const recruiterMeta = {
    'Katherine': { id:'kate',    initials:'KT', color:'#3B6D11', bgLight:'#EAF3DE', bgDark:'#1a3309', campus:'St Pete' },
    'Rebecca': { id:'rebecca', initials:'RB', color:'#BA7517', bgLight:'#FAEEDA', bgDark:'#3d2504', campus:'Tampa' },
    'John':    { id:'john',    initials:'JN', color:'#993556', bgLight:'#FBEAF0', bgDark:'#2a0e1a', campus:'Tampa' },
    'Gabriel':  { id:'gabe',    initials:'GL', color:'#0F6E56', bgLight:'#E1F5EE', bgDark:'#042e24', campus:'St Pete / Tampa' },
    'Tameka':  { id:'tameka',  initials:'TM', color:'#534AB7', bgLight:'#EEEDFE', bgDark:'#1c1852', campus:'Tampa' },
    'JKB':     { id:'jkb',     initials:'JK', color:'#5F5E5A', bgLight:'#F1EFE8', bgDark:'#222220', campus:'Tallahassee' }
  };

  const statusColors = {
    'Recruiter Review (WIP)': '#185FA5', 'Sourced': '#3B6D11', 'Screened': '#BA7517',
    'HM Review': '#993556', 'Interview Stage': '#534AB7', 'Offer Stage': '#0F6E56',
    'Pre-boarding': '#888780', 'Backlog': '#888780', 'Targeted': '#888780'
  };

  const agingBands = [
    { label: 'High 60+', color: '#A32D2D', bgLight: '#FCEBEB', bgDark: '#2e0f0f' },
    { label: 'Med 30-59', color: '#BA7517', bgLight: '#FAEEDA', bgDark: '#3d2504' },
    { label: 'Low <30', color: '#3B6D11', bgLight: '#EAF3DE', bgDark: '#1a3309' }
  ];

  const recruiters = recruiterNames.map(name => {
    const meta = recruiterMeta[name];
    // All reqs owned by this recruiter regardless of status
    const allMyRecs = records.filter(r => getProp(r, 'Owner', 'select') === name);
    // Active reqs only
    const myActive = allMyRecs.filter(r => activeStatuses.includes(getProp(r, 'Status', 'select')));

    console.log(`${name}: ${allMyRecs.length} total, ${myActive.length} active`);

    const statuses = Object.entries(
      myActive.reduce((acc, r) => {
        const s = getProp(r, 'Status', 'select') || 'Unknown';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {})
    ).map(([label, count]) => ({ label, count, color: statusColors[label] || '#888780' }));

    const aging = agingBands.map(band => ({
      ...band,
      count: myActive.filter(r => getProp(r, 'Aging Band', 'select') === band.label).length
    }));

    const ttfValues = allMyRecs.map(r => getProp(r, 'Time to Fill (Days)', 'number')).filter(v => v > 0);
    const avgTTF = ttfValues.length > 0 ? Math.round(ttfValues.reduce((a,b) => a+b, 0) / ttfValues.length) : 0;

    const filled = allMyRecs.filter(r => getProp(r, 'Status', 'select') === 'Hired').length;
    const failed = allMyRecs.filter(r => ['Failed Search', 'Canceled'].includes(getProp(r, 'Status', 'select'))).length;

    const funnel = [
      { label: 'Posted', count: myActive.length },
      { label: 'Screened', count: myActive.filter(r => getProp(r, 'Status', 'select') === 'Screened').length },
      { label: 'HM Review', count: myActive.filter(r => getProp(r, 'Status', 'select') === 'HM Review').length },
      { label: 'Interviews', count: myActive.filter(r => getProp(r, 'Status', 'select') === 'Interview Stage').length },
      { label: 'Offer', count: myActive.filter(r => getProp(r, 'Status', 'select') === 'Offer Stage').length }
    ];

    return {
      id: meta.id, name, initials: meta.initials,
      color: meta.color, bgLight: meta.bgLight, bgDark: meta.bgDark,
      campus: meta.campus,
      reqs: allMyRecs.length,
      filled, failed, ttf: avgTTF,
      statuses, aging, funnel,
      goals: [
        { label: 'Reqs filled', value: filled, target: 10, invert: false },
        { label: 'Time to fill', value: avgTTF, target: 40, invert: true },
        { label: 'Screened', value: myActive.filter(r => getProp(r, 'Status', 'select') === 'Screened').length, target: Math.max(allMyRecs.length, 1), invert: false },
        { label: 'Interviews', value: myActive.filter(r => getProp(r, 'Status', 'select') === 'Interview Stage').length, target: Math.max(allMyRecs.length, 1), invert: false }
      ],
      trend: [avgTTF, avgTTF, avgTTF, avgTTF, avgTTF, avgTTF]
    };
  });

  const campusMap = {
    'Tampa': '#185FA5', 'St. Petersburg': '#3B6D11',
    'USF Health': '#0F6E56', 'Tallahassee': '#993556'
  };
  const campusDisplay = {
    'Tampa': 'Tampa', 'St. Petersburg': 'St Pete',
    'USF Health': 'USF Health', 'Tallahassee': 'Tallahassee'
  };

  const ttfAll = records.map(r => getProp(r, 'Time to Fill (Days)', 'number')).filter(v => v > 0);
  const avgTTFAll = ttfAll.length > 0 ? Math.round(ttfAll.reduce((a,b) => a+b, 0) / ttfAll.length) : 0;

  const data = {
    lastUpdated: new Date().toISOString(),
    summary: {
      openReqs: activeRecords.length,
      avgTimeToFill: avgTTFAll,
      filledYTD: records.filter(r => getProp(r, 'Status', 'select') === 'Hired').length,
      failedCancelled: records.filter(r => ['Failed Search', 'Canceled'].includes(getProp(r, 'Status', 'select'))).length,
      inOfferStage: activeRecords.filter(r => getProp(r, 'Status', 'select') === 'Offer Stage').length
    },
    campus: Object.entries(campusMap).map(([label, color]) => ({
      label: campusDisplay[label],
      count: activeRecords.filter(r => getProp(r, 'Campus', 'select') === label).length,
      color
    })),
    mainFunnel: [
      { label: 'Posted', count: activeRecords.length },
      { label: 'Screened', count: activeRecords.filter(r => getProp(r, 'Status', 'select') === 'Screened').length },
      { label: 'HM Review', count: activeRecords.filter(r => getProp(r, 'Status', 'select') === 'HM Review').length },
      { label: 'Interviews', count: activeRecords.filter(r => getProp(r, 'Status', 'select') === 'Interview Stage').length },
      { label: 'Offer', count: activeRecords.filter(r => getProp(r, 'Status', 'select') === 'Offer Stage').length }
    ],
    mainAging: agingBands.map(band => ({
      ...band,
      count: activeRecords.filter(r => getProp(r, 'Aging Band', 'select') === band.label).length
    })),
    recruiters
  };

  const json = JSON.stringify(data, null, 2);
  console.log('Built data.json — open reqs:', data.summary.openReqs);

  const sha = await getFileSHA();
  const result = await writeToGitHub(json, sha);

  if (result.status === 200 || result.status === 201) {
    console.log('SUCCESS — data.json updated');
  } else {
    console.error('ERROR:', JSON.stringify(result.body));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
