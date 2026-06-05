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
  const body = JSON.stringify({ page_size: 200 });
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
  return res.body.results || [];
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

function countBy(records, propName, value) {
  return records.filter(r => getProp(r, propName, 'select') === value).length;
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
  const body = JSON.stringify({
    message: 'Auto-update data.json from Notion',
    content: encoded,
    sha: sha
  });
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
  console.log(`Found ${records.length} records`);

  const openReqs = records.filter(r => getProp(r, 'Open Req?', 'checkbox') === true).length;

  const campusLabels = ['Tampa','St. Petersburg','USF Health','Tallahassee'];
  const campusColors = ['#185FA5','#3B6D11','#0F6E56','#993556'];
  const campusDisplay = ['Tampa','St Pete','USF Health','Tallahassee'];

  const statusList = [
    'Recruiter Review (WIP)','Sourced','Screened','HM Review',
    'Interview Stage','Offer Stage','Pre-boarding','Hired',
    'Complete','Canceled','Targeted','Failed Search','Faculty','Student Hiring','Backlog'
  ];

  const agingBands = ['Low <30','Med 30-59','High 60+'];

  const recruiterNames = ['Kate','Rebecca','John','Gabe','Tameka','JKB'];
  const recruiterMeta = {
    'Kate':    { id:'kate',    initials:'KT', color:'#3B6D11', bgLight:'#EAF3DE', bgDark:'#1a3309', campus:'St Pete' },
    'Rebecca': { id:'rebecca', initials:'RB', color:'#BA7517', bgLight:'#FAEEDA', bgDark:'#3d2504', campus:'Tampa' },
    'John':    { id:'john',    initials:'JN', color:'#993556', bgLight:'#FBEAF0', bgDark:'#2a0e1a', campus:'Tampa' },
    'Gabe':    { id:'gabe',    initials:'GL', color:'#0F6E56', bgLight:'#E1F5EE', bgDark:'#042e24', campus:'St Pete / Tampa' },
    'Tameka':  { id:'tameka',  initials:'TM', color:'#534AB7', bgLight:'#EEEDFE', bgDark:'#1c1852', campus:'Tampa' },
    'JKB':     { id:'jkb',     initials:'JK', color:'#5F5E5A', bgLight:'#F1EFE8', bgDark:'#222220', campus:'Tallahassee' }
  };

  const recruiters = recruiterNames.map(name => {
    const meta = recruiterMeta[name];
    const myRecs = records.filter(r => getProp(r, 'Owner', 'select') === name);
    const myOpen = myRecs.filter(r => getProp(r, 'Open Req?', 'checkbox') === true);

    const statuses = statusList
      .map(s => ({ label: s, count: myOpen.filter(r => getProp(r, 'Status', 'select') === s).length }))
      .filter(s => s.count > 0);

    const statusColors = {
      'Recruiter Review (WIP)': '#185FA5', 'Sourced': '#3B6D11', 'Screened': '#BA7517',
      'HM Review': '#993556', 'Interview Stage': '#534AB7', 'Offer Stage': '#0F6E56',
      'Pre-boarding': '#888780', 'Hired': '#3B6D11', 'Backlog': '#888780'
    };
    const coloredStatuses = statuses.map(s => ({ ...s, color: statusColors[s.label] || '#888780' }));

    const agingData = agingBands.map(band => ({
      label: band,
      count: myOpen.filter(r => getProp(r, 'Aging Band', 'select') === band).length,
      color: band === 'High 60+' ? '#A32D2D' : band === 'Med 30-59' ? '#BA7517' : '#3B6D11',
      bgLight: band === 'High 60+' ? '#FCEBEB' : band === 'Med 30-59' ? '#FAEEDA' : '#EAF3DE',
      bgDark: band === 'High 60+' ? '#2e0f0f' : band === 'Med 30-59' ? '#3d2504' : '#1a3309'
    }));

    const funnelStages = ['Recruiter Review (WIP)','Sourced','Screened','HM Review','Interview Stage','Offer Stage'];
    const funnel = [
      { label: 'Posted', count: myOpen.length },
      ...funnelStages.slice(1).map(s => ({ label: s.replace('Recruiter Review (WIP)', 'Active'), count: myOpen.filter(r => getProp(r, 'Status', 'select') === s).length }))
    ];

    const ttfValues = myRecs
      .map(r => getProp(r, 'Time to Fill (Days)', 'number'))
      .filter(v => v > 0);
    const avgTTF = ttfValues.length > 0 ? Math.round(ttfValues.reduce((a,b) => a+b, 0) / ttfValues.length) : 0;

    const filled = myRecs.filter(r => getProp(r, 'Status', 'select') === 'Hired').length;
    const failed = myRecs.filter(r => ['Failed Search','Canceled'].includes(getProp(r, 'Status', 'select'))).length;

    return {
      id: meta.id, name, initials: meta.initials,
      color: meta.color, bgLight: meta.bgLight, bgDark: meta.bgDark,
      campus: meta.campus,
      reqs: myOpen.length, filled, failed, ttf: avgTTF,
      statuses: coloredStatuses,
      aging: agingData,
      funnel: funnel.slice(0, 5),
      goals: [
        { label: 'Reqs filled', value: filled, target: 10, invert: false },
        { label: 'Time to fill', value: avgTTF, target: 40, invert: true },
        { label: 'Pool ready', value: myOpen.filter(r => getProp(r, 'Status', 'select') === 'Screened').length, target: Math.max(myOpen.length, 1), invert: false },
        { label: 'Interviews', value: myOpen.filter(r => getProp(r, 'Status', 'select') === 'Interview Stage').length, target: Math.max(myOpen.length, 1), invert: false }
      ],
      trend: [avgTTF, avgTTF, avgTTF, avgTTF, avgTTF, avgTTF]
    };
  });

  const data = {
    lastUpdated: new Date().toISOString(),
    summary: {
      openReqs,
      avgTimeToFill: (() => {
        const vals = records.map(r => getProp(r, 'Time to Fill (Days)', 'number')).filter(v => v > 0);
        return vals.length > 0 ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length) : 0;
      })(),
      filledYTD: records.filter(r => getProp(r, 'Status', 'select') === 'Hired').length,
      failedCancelled: records.filter(r => ['Failed Search','Canceled'].includes(getProp(r, 'Status', 'select'))).length,
      inOfferStage: records.filter(r => getProp(r, 'Status', 'select') === 'Offer Stage').length
    },
    campus: campusLabels.map((label, i) => ({
      label: campusDisplay[i],
      count: records.filter(r => getProp(r, 'Campus', 'select') === label && getProp(r, 'Open Req?', 'checkbox') === true).length,
      color: campusColors[i]
    })),
    mainFunnel: [
      { label: 'Posted', count: openReqs },
      { label: 'Screened', count: countBy(records, 'Status', 'Screened') },
      { label: 'Pool Ready', count: countBy(records, 'Status', 'HM Review') },
      { label: 'Interviews', count: countBy(records, 'Status', 'Interview Stage') },
      { label: 'Offer', count: countBy(records, 'Status', 'Offer Stage') }
    ],
    mainAging: agingBands.map(band => ({
      label: band,
      count: records.filter(r => getProp(r, 'Aging Band', 'select') === band && getProp(r, 'Open Req?', 'checkbox') === true).length,
      color: band === 'High 60+' ? '#A32D2D' : band === 'Med 30-59' ? '#BA7517' : '#3B6D11',
      bgLight: band === 'High 60+' ? '#FCEBEB' : band === 'Med 30-59' ? '#FAEEDA' : '#EAF3DE',
      bgDark: band === 'High 60+' ? '#2e0f0f' : band === 'Med 30-59' ? '#3d2504' : '#1a3309'
    })),
    recruiters
  };

  const json = JSON.stringify(data, null, 2);
  console.log('Built data.json successfully');

  console.log('Getting current SHA...');
  const sha = await getFileSHA();
  console.log('SHA:', sha);

  console.log('Writing to GitHub...');
  const result = await writeToGitHub(json, sha);
  console.log('GitHub response:', result.status);

  if (result.status === 200 || result.status === 201) {
    console.log('SUCCESS — data.json updated');
  } else {
    console.error('ERROR:', JSON.stringify(result.body));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
