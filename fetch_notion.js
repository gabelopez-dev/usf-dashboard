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

async function getCSVFileSHA() {
  const [owner, repo] = GITHUB_REPO.split('/');
  const res = await httpsRequest({
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/contents/data_clean.csv`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'USF-Dashboard-Sync'
    }
  });
  return res.body.sha || null;
}

async function writeCSVToGitHub(content, sha) {
  const [owner, repo] = GITHUB_REPO.split('/');
  const encoded = Buffer.from(content).toString('base64');
  const bodyObj = {
    message: 'Auto-update data_clean.csv from Notion',
    content: encoded,
    ...(sha ? { sha } : {})
  };
  const body = JSON.stringify(bodyObj);
  const res = await httpsRequest({
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/contents/data_clean.csv`,
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
    'Recruiter Review', 'Sourced', 'Screened', 'HM Review',
    'Interview Stage', 'Offer Stage', 'Pre-boarding', 'Backlog',
    'Targeted', 'Posted', 'Active (WIP)', 'Student Hiring', 'Faculty',
    'Open', 'Active', 'Passive', 'Screening', 'Hired'
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
    'Recruiter Review': '#185FA5', 'Sourced': '#3B6D11', 'Screened': '#BA7517',
    'HM Review': '#993556', 'Interview Stage': '#534AB7', 'Offer Stage': '#0F6E56',
    'Pre-boarding': '#888780', 'Backlog': '#888780', 'Targeted': '#888780',
    'Student Hiring': '#0F6E56', 'Faculty': '#534AB7',
    'Passive': '#5B8FA8', 'Active': '#00A693', 'Screening': '#BA7517',
    'Hired': '#2E7D32'
  };

  const agingBands = [
    { label: '🔴 6+',  color: '#A32D2D', bgLight: '#FCEBEB', bgDark: '#2e0f0f' },
    { label: '🟡 3-5', color: '#BA7517', bgLight: '#FAEEDA', bgDark: '#3d2504' },
    { label: '🟢 0–2', color: '#3B6D11', bgLight: '#EAF3DE', bgDark: '#1a3309' }
  ];

  // Helper to match aging band values regardless of dash type (en-dash vs hyphen)
  // and skip N/A, "-", or null values from Notion formula
  function matchAgingBand(recordValue, bandLabel) {
    if (!recordValue || recordValue === 'N/A' || recordValue === '-') return false;
    const normalize = s => s.replace(/–/g, '-').trim();
    return normalize(recordValue) === normalize(bandLabel);
  }

  // Stage colors and order — defined here so they're available in both
  // per-recruiter stageMetrics and the main team-wide stageMetrics
  const stageColors = {
    'Recruiter Review': '#006747', 'Sourced': '#00A693', 'Screened': '#1B6A9C',
    'HM Review': '#534AB7', 'Interview Stage': '#d4880a', 'Offer Stage': '#CFC483',
    'Pre-boarding': '#5B8FA8', 'Backlog': '#888780', 'Targeted': '#7A9EB5',
    'Student Hiring': '#0F6E56', 'Faculty': '#993556'
  };
  const stageOrder = ['Sourced','Recruiter Review','Screened','HM Review','Interview Stage','Offer Stage','Pre-boarding'];

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
      count: myActive.filter(r => matchAgingBand(getProp(r, 'Aging Band', 'formula_text'), band.label)).length
    }));

    const ttfValues = allMyRecs
      .map(r => getProp(r, 'Time to Fill (Days)', 'formula_number'))
      .filter(v => v !== null && v !== undefined && v > 0);
    const avgTTF = ttfValues.length > 0 ? Math.round(ttfValues.reduce((a,b) => a+b, 0) / ttfValues.length) : 0;

    const filled = allMyRecs.filter(r => ['Filled','Complete'].includes(getProp(r, 'Stage', 'select'))).length;
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
      wip: allMyRecs.filter(r => getProp(r, 'WIP ✅', 'checkbox') === true).length,
      agingRecords: agingBands.map(band => ({
        band: band.label,
        color: band.color,
        records: allMyRecs
          .filter(r => matchAgingBand(getProp(r, 'Aging Band', 'formula_text'), band.label))
          .map(r => ({
            title: getProp(r, 'Requistion Title', 'title') || getProp(r, 'Requisition Title', 'title') || getProp(r, 'Name', 'title') || 'Untitled',
            reqId: getProp(r, 'Requisition ID', 'text') || getProp(r, 'Requisition ID', 'number') || '',
          notionUrl: `https://www.notion.so/${(r.id || '').replace(/-/g, '')}`,
            notionUrl: `https://www.notion.so/${(r.id || '').replace(/-/g, '')}`,
            owner: (() => { const p = getProp(r, 'Owner', 'person'); return p?.name || p?.person?.email || 'Unassigned'; })(),
            campus: getProp(r, 'Campus', 'select') || '',
            stage: getProp(r, 'Stage', 'select') || '',
            agingBand: getProp(r, 'Aging Band', 'formula_text') || '',
            department: getProp(r, 'Department/College', 'text') || ''
          }))
      })),
      // Per-recruiter avg time in stage
      stageMetrics: (() => {
        const agg = {};
        myActive.forEach(r => {
          const stage = getProp(r, 'Stage', 'select');
          const days = getProp(r, 'Time in Stage (Days)', 'formula_number');
          if (stage && days !== null && days > 0) {
            if (!agg[stage]) agg[stage] = { total: 0, count: 0 };
            agg[stage].total += days;
            agg[stage].count += 1;
          }
        });
        return stageOrder
          .filter(s => agg[s] && agg[s].count > 0)
          .map(s => ({
            label: s,
            avgDays: Math.round(agg[s].total / agg[s].count),
            count: agg[s].count,
            color: stageColors[s] || '#888780'
          }))
          .concat(
            Object.entries(agg)
              .filter(([s]) => !stageOrder.includes(s))
              .map(([s, v]) => ({
                label: s,
                avgDays: Math.round(v.total / v.count),
                count: v.count,
                color: stageColors[s] || '#888780'
              }))
          );
      })(),
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

  // Req Type breakdown
  // Normalize terminology: Basic → Passive, Premier → Active
  const reqTypeNormalize = label => {
    if (!label) return label;
    if (label.toLowerCase() === 'basic') return 'Passive';
    if (label.toLowerCase() === 'premier') return 'Active';
    if (label.toLowerCase() === 'standard') return 'Active';
    return label;
  };

  // Consistent colors per service level type
  const reqTypeColorMap = {
    'Passive':   '#006747',
    'Active':    '#00A693',
    'Standard':  '#006747',
    'Evergreen': '#7A9EB5',
    'Faculty':   '#534AB7',
    'Student':   '#1B6A9C',
    'Targeted':  '#CFC483'
  };
  const reqTypeFallbackColors = ['#5B7A8A','#993556','#d4880a','#888780'];

  const reqTypeAgg = {};
  activeRecords.forEach(r => {
    const raw = getProp(r, 'Req Type', 'select');
    const t = reqTypeNormalize(raw);
    if (t) reqTypeAgg[t] = (reqTypeAgg[t] || 0) + 1;
  });
  let fallbackIdx = 0;
  const reqTypeBreakdown = Object.entries(reqTypeAgg)
    .sort((a,b) => b[1] - a[1])
    .map(([label, count]) => ({
      label,
      count,
      color: reqTypeColorMap[label] || reqTypeFallbackColors[fallbackIdx++ % reqTypeFallbackColors.length]
    }));

  // Department/College breakdown - same dynamic approach
  const deptColors = ['#006747', '#1B6A9C', '#00A693', '#CFC483', '#7A9EB5', '#5B7A8A', '#534AB7', '#993556'];
  const deptAgg = {};
  activeRecords.forEach(r => {
    const d = getProp(r, 'Department/College', 'text') || getProp(r, 'Department/College', 'select');
    if (d) deptAgg[d] = (deptAgg[d] || 0) + 1;
  });
  // Group departments with 5 or fewer reqs into "Other" to keep the bar chart readable
  const DEPT_MIN_COUNT = 5;
  const deptSorted = Object.entries(deptAgg).sort((a,b) => b[1] - a[1]);
  const deptMain = deptSorted.filter(([,count]) => count > DEPT_MIN_COUNT);
  const deptOther = deptSorted.filter(([,count]) => count <= DEPT_MIN_COUNT);
  const otherCount = deptOther.reduce((sum, [,count]) => sum + count, 0);

  const deptBreakdown = [
    ...deptMain.map(([label, count], i) => ({ label, count, color: deptColors[i % deptColors.length] })),
    ...(otherCount > 0 ? [{ label: `Other (${deptOther.length} depts)`, count: otherCount, color: '#c8c7c2' }] : [])
  ];

  console.log('Req Type breakdown:', JSON.stringify(reqTypeBreakdown));
  // DEBUG: verify formula fields are being read correctly
  const sampleAging = activeRecords.slice(0, 5).map(r => getProp(r, 'Aging Band', 'formula_text'));
  console.log('Sample Aging Band values (raw):', JSON.stringify(sampleAging));
  const agingCounts = agingBands.map(b => ({
    band: b.label,
    count: activeRecords.filter(r => matchAgingBand(getProp(r, 'Aging Band', 'formula_text'), b.label)).length
  }));
  console.log('Aging band counts:', JSON.stringify(agingCounts));
  console.log('Department breakdown:', JSON.stringify(deptBreakdown));
  // DEBUG: if breakdown is empty, show the raw property so we can see its actual shape
  if (deptBreakdown.length === 0 && records.length > 0) {
    console.log('DEBUG raw Department/College property on first record:', JSON.stringify(records[0].properties?.['Department/College']));
  }

  // Avg Time in Stage per stage
  const stageTimeAgg = {};
  activeRecords.forEach(r => {
    const stage = getProp(r, 'Stage', 'select');
    const days = getProp(r, 'Time in Stage (Days)', 'formula_number');
    if (stage && days !== null && days > 0) {
      if (!stageTimeAgg[stage]) stageTimeAgg[stage] = { total: 0, count: 0 };
      stageTimeAgg[stage].total += days;
      stageTimeAgg[stage].count += 1;
    }
  });
  const stageMetrics = stageOrder
    .filter(s => stageTimeAgg[s] && stageTimeAgg[s].count > 0)
    .map(s => ({
      label: s,
      avgDays: Math.round(stageTimeAgg[s].total / stageTimeAgg[s].count),
      count: stageTimeAgg[s].count,
      color: stageColors[s] || '#888780'
    }));
  Object.entries(stageTimeAgg)
    .filter(([s]) => !stageOrder.includes(s))
    .forEach(([s, v]) => stageMetrics.push({
      label: s,
      avgDays: Math.round(v.total / v.count),
      count: v.count,
      color: stageColors[s] || '#888780'
    }));
  console.log('Stage metrics:', JSON.stringify(stageMetrics));

  const data = {
    lastUpdated: new Date().toISOString(),
    summary: {
      openReqs: activeRecords.length,
      avgTimeToFill: avgTTFAll,
      filledYTD: records.filter(r => ['Filled','Complete'].includes(getProp(r, 'Stage', 'select'))).length,
      failedCancelled: records.filter(r => ['Failed Search', 'Canceled'].includes(getProp(r, 'Stage', 'select'))).length,
      inOfferStage: activeRecords.filter(r => getProp(r, 'Stage', 'select') === 'Offer Stage').length
    },
    campus: Object.entries(campusMap).map(([label, color]) => ({
      label: campusDisplay[label],
      count: activeRecords.filter(r => getProp(r, 'Campus', 'select') === label).length,
      color
    })),
    // Dynamic funnel - shows ALL stages that have active reqs, sorted by count descending
    // This way Pre-boarding, Recruiter Review, Sourced etc. are all visible
    mainFunnel: Object.entries(
      activeRecords.reduce((acc, r) => {
        const stage = getProp(r, 'Stage', 'select') || 'No Stage';
        acc[stage] = (acc[stage] || 0) + 1;
        return acc;
      }, {})
    )
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count })),
    mainAging: agingBands.map(band => ({
      ...band,
      count: activeRecords.filter(r => matchAgingBand(getProp(r, 'Aging Band', 'formula_text'), band.label)).length
    })),
    // Per-record aging data for heatmap drill-down click functionality
    agingRecords: agingBands.map(band => ({
      band: band.label,
      color: band.color,
      records: activeRecords
        .filter(r => matchAgingBand(getProp(r, 'Aging Band', 'formula_text'), band.label))
        .map(r => ({
          title: getProp(r, 'Requistion Title', 'title') || getProp(r, 'Requisition Title', 'title') || getProp(r, 'Name', 'title') || 'Untitled',
          reqId: getProp(r, 'Requisition ID', 'text') || getProp(r, 'Requisition ID', 'number') || '',
          notionUrl: `https://www.notion.so/${(r.id || '').replace(/-/g, '')}`,
          owner: (() => { const p = getProp(r, 'Owner', 'person'); return p?.name || p?.person?.email || 'Unassigned'; })(),
          campus: getProp(r, 'Campus', 'select') || '',
          stage: getProp(r, 'Stage', 'select') || '',
          agingBand: getProp(r, 'Aging Band', 'formula_text') || '',
          department: getProp(r, 'Department/College', 'text') || ''
        }))
    })),
    reqType: reqTypeBreakdown,
    department: deptBreakdown,
    stageMetrics,
    // Closed reqs for historical wins/losses view
    closedReqs: records
      .filter(r => ['Filled', 'Canceled', 'Failed Search', 'Complete'].includes(getProp(r, 'Stage', 'select')))
      .map(r => ({
        title: getProp(r, 'Requistion Title', 'title') || getProp(r, 'Requisition Title', 'title') || getProp(r, 'Name', 'title') || 'Untitled',
        reqId: getProp(r, 'Requisition ID', 'text') || getProp(r, 'Requisition ID', 'number') || '',
        owner: (() => { const p = getProp(r, 'Owner', 'person'); return p?.name || p?.person?.email || 'Unassigned'; })(),
        campus: getProp(r, 'Campus', 'select') || '',
        stage: getProp(r, 'Stage', 'select') || '',
        department: getProp(r, 'Department/College', 'text') || '',
        ttf: getProp(r, 'Time to Fill (Days)', 'formula_number') || 0,
        notionUrl: `https://www.notion.so/${(r.id || '').replace(/-/g, '')}`
      }))
      .sort((a, b) => (b.ttf || 0) - (a.ttf || 0)),
    recruiters,

    // Data quality — flags records missing critical fields
    dataQuality: (() => {
      const criticalFields = [
        { key: 'stage',      label: 'Stage',              check: r => !getProp(r, 'Stage', 'select') },
        { key: 'department', label: 'Department/College',  check: r => !getProp(r, 'Department/College', 'text') },
        { key: 'lastActivity',label: 'Last Activity',     check: r => !getProp(r, 'Last Activity', 'date') && !getProp(r, 'Last Activity', 'text') },
        { key: 'reqType',    label: 'Req Type',            check: r => !getProp(r, 'Req Type', 'select') },
        { key: 'campus',     label: 'Campus',              check: r => !getProp(r, 'Campus', 'select') },
        { key: 'hrbp',       label: 'HRBP',               check: r => !getProp(r, 'HRBP', 'text') && !getProp(r, 'HRBP', 'select') },
      ];

      return criticalFields.map(f => {
        const missing = activeRecords.filter(f.check);
        return {
          field: f.label,
          missingCount: missing.length,
          totalActive: activeRecords.length,
          pct: activeRecords.length > 0 ? Math.round((missing.length / activeRecords.length) * 100) : 0,
          records: missing.slice(0, 50).map(r => ({
            title: getProp(r, 'Requistion Title', 'title') || getProp(r, 'Requisition Title', 'title') || 'Untitled',
            reqId: getProp(r, 'Requisition ID', 'text') || getProp(r, 'Requisition ID', 'number') || '',
            owner: (() => { const p = getProp(r, 'Owner', 'person'); return p?.name || p?.person?.email || 'Unassigned'; })(),
            campus: getProp(r, 'Campus', 'select') || '',
            stage: getProp(r, 'Stage', 'select') || '',
            notionUrl: `https://www.notion.so/${(r.id || '').replace(/-/g, '')}`
          }))
        };
      });
    })()
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

  // Build clean CSV for Power BI
  const csvHeaders = [
    'Req Title', 'Req ID', 'Owner', 'Stage', 'Req Type',
    'Campus', 'Department/College', 'HRBP', 'Hiring Manager',
    'Time to Fill (Days)', 'Time in Stage (Days)',
    'Aging Band', 'Posted Date', 'Last Activity', 'Open Req'
  ];

  // Helper to clean a value for CSV — strip emoji, dashes, rich text artifacts
  const cleanVal = val => {
    if (val === null || val === undefined || val === '' || val === '-' || val === '—') return '';
    let s = String(val);
    // Strip emoji aging band prefixes — keep just the text part e.g. "6+", "3-5", "0-2"
    s = s.replace(/🔴\s*/g, '').replace(/🟡\s*/g, '').replace(/🟢\s*/g, '');
    // Strip other common emoji
    s = s.replace(/[\u{1F300}-\u{1FFFF}]/gu, '').trim();
    // Escape quotes for CSV
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const csvRows = records.map(r => {
    const owner = (() => { const p = getProp(r, 'Owner', 'person'); return p?.name || p?.person?.email || ''; })();
    const raw = getProp(r, 'Req Type', 'select');
    const reqType = reqTypeNormalize(raw) || '';
    return [
      cleanVal(getProp(r, 'Requistion Title', 'title') || getProp(r, 'Requisition Title', 'title') || getProp(r, 'Name', 'title')),
      cleanVal(getProp(r, 'Requisition ID', 'text') || getProp(r, 'Requisition ID', 'number')),
      cleanVal(owner),
      cleanVal(getProp(r, 'Stage', 'select')),
      cleanVal(reqType),
      cleanVal(getProp(r, 'Campus', 'select')),
      cleanVal(getProp(r, 'Department/College', 'text')),
      cleanVal(getProp(r, 'HRBP', 'text') || getProp(r, 'HRBP', 'select')),
      cleanVal(getProp(r, 'Hiring Manager', 'text') || getProp(r, 'Hiring Manager', 'select')),
      cleanVal(getProp(r, 'Time to Fill (Days)', 'formula_number') || ''),
      cleanVal(getProp(r, 'Time in Stage (Days)', 'formula_number') || ''),
      cleanVal((getProp(r, 'Aging Band', 'formula_text') || '').replace(/🔴\s*/g,'').replace(/🟡\s*/g,'').replace(/🟢\s*/g,'').trim()),
      cleanVal(getProp(r, 'Posted Date', 'date') || getProp(r, 'Posted Date', 'text')),
      cleanVal(getProp(r, 'Last Activity', 'date') || getProp(r, 'Last Activity', 'text')),
      cleanVal(getProp(r, 'Open Req (Yes/No)', 'checkbox') ? 'Yes' : 'No')
    ].join(',');
  });

  const csvContent = [csvHeaders.join(','), ...csvRows].join('\n');
  console.log(`Built data_clean.csv — ${csvRows.length} rows`);

  const csvSha = await getCSVFileSHA();
  const csvResult = await writeCSVToGitHub(csvContent, csvSha);
  if (csvResult.status === 200 || csvResult.status === 201) {
    console.log('SUCCESS — data_clean.csv updated');
  } else {
    console.error('CSV ERROR:', JSON.stringify(csvResult.body));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
