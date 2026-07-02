const https = require('https');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

// Single shared Master Database - all recruiters live here.
const NOTION_DB_ID = '5b6e328b-232a-41cf-9ba2-2563a949d206';

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

// Queries a single database by ID, paginating through all results
async function queryNotionDatabase(dbId) {
  let results = [];
  let cursor = undefined;
  do {
    const bodyObj = { page_size: 100 };
    if (cursor) bodyObj.start_cursor = cursor;
    const body = JSON.stringify(bodyObj);
    const res = await httpsRequest({
      hostname: 'api.notion.com',
      path: `/v1/databases/${dbId}/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
    if (res.body.results) {
      results = results.concat(res.body.results);
    } else {
      // Surface permission/connection errors clearly instead of silently returning 0
      console.error(`  ERROR querying database ${dbId}:`, JSON.stringify(res.body));
    }
    cursor = res.body.has_more ? res.body.next_cursor : undefined;
  } while (cursor);
  return results;
}

// Queries the single Master Database, paginating through all results.
async function queryNotion() {
  return await queryNotionDatabase(NOTION_DB_ID);
}

function getProp(page, propName, type) {
  const prop = page.properties?.[propName];
  if (!prop) return null;
  switch(type) {
    case 'select': return prop.select?.name || null;
    case 'person': return prop.people?.[0] || null;
    case 'checkbox': return prop.checkbox || false;
    case 'number': return prop.number || 0;
    case 'formula_text': return prop.formula?.string || null;
    case 'formula_number': {
      const val = prop.formula?.number;
      return (val !== undefined && val !== null) ? val : null;
    }
    case 'date': return prop.date?.start || null;
    case 'title': return prop.title?.[0]?.text?.content || prop.title?.[0]?.plain_text || null;
    case 'text': return prop.rich_text?.[0]?.text?.content || prop.rich_text?.[0]?.plain_text || null;
    default: return null;
  }
}

// Matches a recruiter against a Notion person object by checking
// name, email, and raw id against a list of known identifiers
function ownerMatches(personObj, identifiers) {
  if (!personObj) return false;
  const name = (personObj.name || '').toLowerCase();
  const email = (personObj.person?.email || '').toLowerCase();
  const id = (personObj.id || '').toLowerCase();
  return identifiers.some(idf => {
    const needle = idf.toLowerCase();
    return name.includes(needle) || email.includes(needle) || id === needle;
  });
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

  // DEBUG: sample a few Owner values across the merged set so we can verify
  // matching is working correctly across both databases
  const sampleOwners = records.slice(0, 8).map(r => getProp(r, 'Owner', 'person'));
  console.log('Sample Owner objects:', JSON.stringify(sampleOwners));

  // DEBUG: show every unique Status value across ALL records, so we catch
  // any other database-specific status text we haven't accounted for yet
  const allStatusValues = [...new Set(records.map(r => getProp(r, 'Stage', 'select')))];
  console.log('All unique Stage values found:', JSON.stringify(allStatusValues));

  // Active statuses - kept "Open"/"Active" as harmless legacy entries in case
  // any rows still carry those values during the Katherine/Gabriel migration
  const activeStatuses = [
    'Recruiter Review (WIP)', 'Sourced', 'Screened', 'HM Review',
    'Interview Stage', 'Offer Stage', 'Pre-boarding', 'Backlog',
    'Targeted', 'Posted', 'Active (WIP)', 'Student Hiring', 'Faculty',
    'Open', 'Active'
  ];

  const activeRecords = records.filter(r => {
    const status = getProp(r, 'Stage', 'select');
    return activeStatuses.includes(status);
  });

  console.log(`Active records: ${activeRecords.length}`);

  // Identifiers used for matching against Notion person objects (name, email fragments)
  const recruiterNames = ['Katherine', 'Rebecca', 'John', 'Gabriel', 'Tameka'];
  const recruiterIdentifiers = {
    'Katherine': ['katherine', 'friborg'],
    'Rebecca':   ['rebecca'],
    'John':      ['john', 'calebrese'],
    'Gabriel':    ['gabriel', 'glopez', 'gabe'],
    'Tameka':    ['tameka', 'porter']
  };
  const recruiterMeta = {
    'Katherine': { id:'katherine', initials:'KT', color:'#1B7A5A', bgLight:'#e6f5f0', bgDark:'#1a3309', campus:'St Pete' },
    'Rebecca':   { id:'rebecca',   initials:'RB', color:'#1B6A9C', bgLight:'#e0f5f3', bgDark:'#3d2504', campus:'Tampa' },
    'John':      { id:'john',      initials:'JN', color:'#1B6A9C', bgLight:'#e3f2fd', bgDark:'#2a0e1a', campus:'Tampa' },
    'Gabriel':    { id:'gabriel',   initials:'GL', color:'#00A693', bgLight:'#e6f2ed', bgDark:'#042e24', campus:'St Pete / Tampa' },
    'Tameka':    { id:'tameka',    initials:'TM', color:'#00A693', bgLight:'#e0f5f8', bgDark:'#1c1852', campus:'Tampa' }
  };

  const statusColors = {
    'Recruiter Review (WIP)': '#185FA5', 'Sourced': '#3B6D11', 'Screened': '#BA7517',
    'HM Review': '#993556', 'Interview Stage': '#534AB7', 'Offer Stage': '#0F6E56',
    'Pre-boarding': '#888780', 'Backlog': '#888780', 'Targeted': '#888780',
    'Student Hiring': '#0F6E56', 'Faculty': '#534AB7'
  };

  const agingBands = [
    { label: '🔴 6+',  color: '#A32D2D', bgLight: '#FCEBEB', bgDark: '#2e0f0f' },
    { label: '🟡 3-5', color: '#BA7517', bgLight: '#FAEEDA', bgDark: '#3d2504' },
    { label: '🟢 0–2', color: '#3B6D11', bgLight: '#EAF3DE', bgDark: '#1a3309' }
  ];

  const recruiters = recruiterNames.map(name => {
    const meta = recruiterMeta[name];
    const identifiers = recruiterIdentifiers[name];

    // Matched against the Owner person field (name, email, or id) since both
    // Master Databases contain a mix of every recruiter's records together.
    const allMyRecs = records.filter(r => {
      const owner = getProp(r, 'Owner', 'person');
      return ownerMatches(owner, identifiers);
    });

    // Active reqs only
    const myActive = allMyRecs.filter(r => activeStatuses.includes(getProp(r, 'Stage', 'select')));

    console.log(`${name}: ${allMyRecs.length} total, ${myActive.length} active`);

    const statuses = Object.entries(
      myActive.reduce((acc, r) => {
        const s = getProp(r, 'Stage', 'select') || 'Unknown';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {})
    ).map(([label, count]) => ({ label, count, color: statusColors[label] || '#888780' }));


    const aging = agingBands.map(band => ({
      ...band,
      count: myActive.filter(r => getProp(r, 'Aging Band', 'formula_text') === band.label).length
    }));

    const ttfValues = allMyRecs
      .map(r => getProp(r, 'Time to Fill (Days)', 'formula_number'))
      .filter(v => v !== null && v !== undefined && v > 0);
    const avgTTF = ttfValues.length > 0 ? Math.round(ttfValues.reduce((a,b) => a+b, 0) / ttfValues.length) : 0;

    const filled = allMyRecs.filter(r => getProp(r, 'Stage', 'select') === 'Hired').length;
    const failed = allMyRecs.filter(r => ['Failed Search', 'Canceled'].includes(getProp(r, 'Stage', 'select'))).length;

    const funnel = [
      { label: 'Posted', count: myActive.length },
      { label: 'Screened', count: myActive.filter(r => getProp(r, 'Stage', 'select') === 'Screened').length },
      { label: 'HM Review', count: myActive.filter(r => getProp(r, 'Stage', 'select') === 'HM Review').length },
      { label: 'Interviews', count: myActive.filter(r => getProp(r, 'Stage', 'select') === 'Interview Stage').length },
      { label: 'Offer', count: myActive.filter(r => getProp(r, 'Stage', 'select') === 'Offer Stage').length }
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
        { label: 'Screened', value: myActive.filter(r => getProp(r, 'Stage', 'select') === 'Screened').length, target: Math.max(allMyRecs.length, 1), invert: false },
        { label: 'Interviews', value: myActive.filter(r => getProp(r, 'Stage', 'select') === 'Interview Stage').length, target: Math.max(allMyRecs.length, 1), invert: false }
      ],
      trend: [avgTTF, avgTTF, avgTTF, avgTTF, avgTTF, avgTTF]
    };
  });

  const campusMap = {
    'Tampa': '#1B6A9C', 'St. Petersburg': '#006747',
    'USF Health': '#00A693', 'Tallahassee': '#7A9EB5', 'Sarasota-Manatee': '#5B7A8A'
  };
  const campusDisplay = {
    'Tampa': 'Tampa', 'St. Petersburg': 'St Pete',
    'USF Health': 'USF Health', 'Tallahassee': 'Tallahassee', 'Sarasota-Manatee': 'Sarasota'
  };

  const ttfAll = records
    .map(r => getProp(r, 'Time to Fill (Days)', 'formula_number'))
    .filter(v => v !== null && v !== undefined && v > 0);
  const avgTTFAll = ttfAll.length > 0 ? Math.round(ttfAll.reduce((a,b) => a+b, 0) / ttfAll.length) : 0;
  console.log(`TTF values found: ${ttfAll.length}, avg: ${avgTTFAll}`);

  // Req Type breakdown - colors assigned dynamically in case new types appear in Notion
  const reqTypeColors = ['#006747', '#00A693', '#1B6A9C', '#CFC483', '#7A9EB5', '#5B7A8A'];
  const reqTypeAgg = {};
  activeRecords.forEach(r => {
    const t = getProp(r, 'Req Type', 'select');
    if (t) reqTypeAgg[t] = (reqTypeAgg[t] || 0) + 1;
  });
  const reqTypeBreakdown = Object.entries(reqTypeAgg)
    .sort((a,b) => b[1] - a[1])
    .map(([label, count], i) => ({ label, count, color: reqTypeColors[i % reqTypeColors.length] }));

  // Department/College breakdown - same dynamic approach
  const deptColors = ['#006747', '#1B6A9C', '#00A693', '#CFC483', '#7A9EB5', '#5B7A8A', '#534AB7', '#993556'];
  const deptAgg = {};
  activeRecords.forEach(r => {
    const d = getProp(r, 'Department/College', 'text') || getProp(r, 'Department/College', 'select');
    if (d) deptAgg[d] = (deptAgg[d] || 0) + 1;
  });
  const deptBreakdown = Object.entries(deptAgg)
    .sort((a,b) => b[1] - a[1])
    .map(([label, count], i) => ({ label, count, color: deptColors[i % deptColors.length] }));

  console.log('Req Type breakdown:', JSON.stringify(reqTypeBreakdown));
  // DEBUG: verify formula fields are being read correctly
  const sampleAging = activeRecords.slice(0, 3).map(r => getProp(r, 'Aging Band', 'formula_text'));
  const sampleTTF = records.slice(0, 3).map(r => getProp(r, 'Time to Fill (Days)', 'formula_number'));
  console.log('Sample Aging Band values:', JSON.stringify(sampleAging));
  console.log('Sample Time to Fill values:', JSON.stringify(sampleTTF));
  // DEBUG: show raw Aging Band property to find correct API shape
  if (sampleAging.every(v => v === null) && activeRecords.length > 0) {
    console.log('DEBUG raw Aging Band property:', JSON.stringify(activeRecords[0].properties?.['Aging Band']));
  }
  console.log('Department breakdown:', JSON.stringify(deptBreakdown));
  // DEBUG: if breakdown is empty, show the raw property so we can see its actual shape
  if (deptBreakdown.length === 0 && records.length > 0) {
    console.log('DEBUG raw Department/College property on first record:', JSON.stringify(records[0].properties?.['Department/College']));
  }

  const data = {
    lastUpdated: new Date().toISOString(),
    summary: {
      openReqs: activeRecords.length,
      avgTimeToFill: avgTTFAll,
      filledYTD: records.filter(r => getProp(r, 'Stage', 'select') === 'Hired').length,
      failedCancelled: records.filter(r => ['Failed Search', 'Canceled'].includes(getProp(r, 'Stage', 'select'))).length,
      inOfferStage: activeRecords.filter(r => getProp(r, 'Stage', 'select') === 'Offer Stage').length
    },
    campus: Object.entries(campusMap).map(([label, color]) => ({
      label: campusDisplay[label],
      count: activeRecords.filter(r => getProp(r, 'Campus', 'select') === label).length,
      color
    })),
    mainFunnel: [
      { label: 'Posted', count: activeRecords.length },
      { label: 'Screened', count: activeRecords.filter(r => getProp(r, 'Stage', 'select') === 'Screened').length },
      { label: 'HM Review', count: activeRecords.filter(r => getProp(r, 'Stage', 'select') === 'HM Review').length },
      { label: 'Interviews', count: activeRecords.filter(r => getProp(r, 'Stage', 'select') === 'Interview Stage').length },
      { label: 'Offer', count: activeRecords.filter(r => getProp(r, 'Stage', 'select') === 'Offer Stage').length }
    ],
    mainAging: agingBands.map(band => ({
      ...band,
      count: activeRecords.filter(r => getProp(r, 'Aging Band', 'formula_text') === band.label).length
    })),
    reqType: reqTypeBreakdown,
    department: deptBreakdown,
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
