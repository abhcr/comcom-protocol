const search = document.querySelector('#search');
const list = document.querySelector('#capabilities');
const profiles = document.querySelector('#profiles');
const count = document.querySelector('#count');
const status = document.querySelector('#catalog-status');
const pageLabel = document.querySelector('#page');
const previous = document.querySelector('#previous');
const next = document.querySelector('#next');
const pageSize = 24;
let registry;
let selectedProfile = 'all';
let currentPage = 1;

function render() {
  if (!registry) return;
  const query = search.value.trim().toLowerCase();
  const matches = registry.capabilities.filter(capability => {
    const profileMatch = selectedProfile === 'all' || capability.profile === selectedProfile;
    const queryMatch = !query || `${capability.id} ${capability.title} ${capability.purpose} ${capability.resourceType} ${capability.profile}`.toLowerCase().includes(query);
    return profileMatch && queryMatch;
  });
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  currentPage = Math.min(currentPage, pages);
  const visible = matches.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  count.textContent = matches.length;
  status.textContent = `Showing ${matches.length} result${matches.length === 1 ? '' : 's'}; page ${currentPage} of ${pages}.`;
  pageLabel.textContent = `Page ${currentPage} of ${pages}`;
  previous.disabled = currentPage === 1;
  next.disabled = currentPage === pages;
  list.replaceChildren(...visible.map(capability => {
    const article = document.createElement('article');
    article.className = 'capability';
    const link = document.createElement('a');
    link.href = `./capabilities/${capability.id.replaceAll('.', '-')}.html`;
    const id = document.createElement('small');
    id.textContent = capability.id;
    const title = document.createElement('b');
    title.textContent = capability.title;
    const purpose = document.createElement('p');
    purpose.textContent = capability.purpose;
    const tags = document.createElement('div');
    tags.className = 'tags';
    for (const value of [capability.requestKind, capability.status]) {
      const tag = document.createElement('span');
      tag.textContent = value;
      tags.append(tag);
    }
    link.append(id, title, purpose, tags);
    article.append(link);
    return article;
  }));
}

try {
  const response = await fetch('./registry/v0.2/capabilities.json');
  if (!response.ok) throw new Error(`registry returned ${response.status}`);
  registry = await response.json();
  const profileNames = [...new Set(registry.capabilities.map(capability => capability.profile))].sort();
  for (const profile of ['all', ...profileNames]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = profile === 'all' ? 'All profiles' : profile;
    button.classList.toggle('active', profile === 'all');
    button.setAttribute('aria-pressed', profile === 'all' ? 'true' : 'false');
    button.addEventListener('click', () => {
      selectedProfile = profile;
      currentPage = 1;
      for (const item of profiles.children) {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      }
      render();
    });
    profiles.append(button);
  }
  document.querySelector('#js-status').hidden = true;
  render();
} catch (error) {
  status.textContent = 'Interactive catalog unavailable. Use the complete no-JavaScript catalog link below.';
}

search.addEventListener('input', () => { currentPage = 1; render(); });
previous.addEventListener('click', () => { currentPage -= 1; render(); document.querySelector('#catalog').scrollIntoView(); });
next.addEventListener('click', () => { currentPage += 1; render(); document.querySelector('#catalog').scrollIntoView(); });

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.querySelector(`#${button.dataset.copy}`).textContent);
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = label; }, 1200);
  });
}

const documentType = document.querySelector('#document-type');
const manifestProfile = document.querySelector('#manifest-profile');
const file = document.querySelector('#document-file');
const documentJson = document.querySelector('#document-json');
file.addEventListener('change', async () => {
  if (file.files[0]) documentJson.value = await file.files[0].text();
});

document.querySelector('#load-example').addEventListener('click', () => {
  if (!window.comcomOffline) return;
  const name = documentType.value === 'manifest' && manifestProfile.value.includes('/v0.2.0/') ? 'legacy-manifest' : documentType.value;
  const example = structuredClone(window.comcomOffline.examples[name]);
  if (example.issuedAt) {
    const now = Date.now();
    example.issuedAt = new Date(now).toISOString();
    if (example.expiresAt) example.expiresAt = new Date(now + 300_000).toISOString();
  }
  documentJson.value = JSON.stringify(example, null, 2);
  documentJson.focus();
});

document.querySelector('#validator-form').addEventListener('submit', event => {
  event.preventDefault();
  const output = document.querySelector('#validator-result');
  if (!window.comcomOffline) {
    output.className = 'invalid';
    output.textContent = 'The bundled validator failed to load. Use the Node or Python CLI.';
    return;
  }
  const verdict = window.comcomOffline.validate(documentType.value, documentJson.value, { manifestProfile: manifestProfile.value });
  output.className = verdict.valid ? 'valid' : 'invalid';
  output.textContent = verdict.valid
    ? 'Valid document shape against the selected bundled schemas. Transport and business behavior are not verified.'
    : `${verdict.phase}: ${verdict.code}\n${verdict.errors.map(error => `${error.path} ${error.message}`).join('\n')}`;
});
