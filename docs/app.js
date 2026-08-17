const response = await fetch('./registry/v0.1/capabilities.json');
const registry = await response.json();
const search = document.querySelector('#search');
const list = document.querySelector('#capabilities');
const domains = document.querySelector('#domains');
const count = document.querySelector('#count');
let selectedDomain = 'all';

const domainNames = [...new Set(registry.capabilities.map(capability => capability.domain))].sort();
for (const domain of ['all', ...domainNames]) {
  const button = document.createElement('button');
  button.textContent = domain === 'all' ? 'All' : domain.replace(/([A-Z])/g, ' $1');
  button.dataset.domain = domain;
  button.classList.toggle('active', domain === 'all');
  button.addEventListener('click', () => {
    selectedDomain = domain;
    for (const item of domains.children) item.classList.toggle('active', item === button);
    render();
  });
  domains.append(button);
}

function render() {
  const query = search.value.trim().toLowerCase();
  const matches = registry.capabilities.filter(capability => {
    const domainMatch = selectedDomain === 'all' || capability.domain === selectedDomain;
    const queryMatch = !query || `${capability.id} ${capability.title} ${capability.purpose} ${capability.resourceType}`.toLowerCase().includes(query);
    return domainMatch && queryMatch;
  });
  count.textContent = matches.length;
  list.replaceChildren(...matches.map(capability => {
    const article = document.createElement('article');
    article.className = 'capability';
    const id = document.createElement('small');
    id.textContent = capability.id;
    const title = document.createElement('b');
    title.textContent = capability.title;
    const purpose = document.createElement('p');
    purpose.textContent = capability.purpose;
    const tags = document.createElement('div');
    for (const value of [capability.kind, capability.resourceType]) {
      const tag = document.createElement('span');
      tag.textContent = value;
      tags.append(tag);
    }
    article.append(id, title, purpose, tags);
    return article;
  }));
}

search.addEventListener('input', render);
document.querySelector('[data-copy="discovery"]').addEventListener('click', async event => {
  await navigator.clipboard.writeText(document.querySelector('#discovery').textContent);
  event.currentTarget.textContent = 'Copied';
  setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1200);
});
render();
