import { expect, test, type Page } from '@playwright/test';

async function startDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Experimentar demo' }).click();
  // O saldo só aparece depois que o React hidratou e carregou /api/me: antes disso, o texto digitado se perde.
  await expect(page.getByText(/créditos disponíveis/)).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder('Mensagem…').fill(text);
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar' }).click();
}

test('resposta continua após recarregar no meio do streaming, sem texto duplicado', async ({ page }) => {
  await startDemo(page);
  await send(page, 'teste de reconexão');
  // Espera o streaming começar e recarrega antes de terminar.
  await expect(page.getByText('Resposta simulada', { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('validar streaming, persistência e recuperação')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('validar streaming, persistência e recuperação')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Resposta simulada (turno 1)')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Ver execução' })).toBeVisible();
});

test('cancelar interrompe a resposta e marca como cancelada', async ({ page }) => {
  await startDemo(page);
  await send(page, 'esta resposta será cancelada');
  await expect(page.getByText('Resposta simulada', { exact: false })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByText('cancelada', { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('servidor MCP cadastrado pela interface é usado e citado como fonte', async ({ page }) => {
  await startDemo(page);
  await send(page, 'olá');
  await expect(page.getByRole('button', { name: 'Ver execução' })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Conectores' }).click();
  await page.getByPlaceholder('nome', { exact: true }).fill('demo');
  await page.getByPlaceholder('https://servidor/mcp').fill('http://localhost:3102/mcp');
  await page.getByRole('button', { name: 'Adicionar servidor MCP' }).click();
  await expect(page.getByText('Tools: catalog_search, quote_calculate')).toBeVisible();
  await page.getByRole('button', { name: 'Fechar' }).click();

  await page.getByRole('button', { name: /^Ferramentas/ }).click();
  // Checkbox controlado: o estado só muda depois que a API confirma.
  // A lista recarrega ao fechar os conectores; o item do MCP só existe depois disso.
  const mcpTool = page.getByRole('checkbox', { name: 'demo mcp' });
  await mcpTool.click();
  await expect(mcpTool).toBeChecked();
  await send(page, 'monitores? [[tool:mcp_demo_catalog_search {"category":"monitor"}]]');
  await expect(page.getByText('Fontes citadas')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText('demo · catalog_search').first()).toBeVisible();

  await page.getByRole('button', { name: 'Ver execução' }).last().click();
  await expect(page.getByText(/mcp_demo_catalog_search: ok/)).toBeVisible();
});

test('snapshot compartilhado abre anonimamente e deixa de abrir após revogar', async ({ page, browser }) => {
  await startDemo(page);
  await send(page, 'conteúdo público do snapshot');
  await expect(page.getByRole('button', { name: 'Ver execução' })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Compartilhar' }).click();
  await page.getByRole('button', { name: 'Publicar link' }).click();
  const url = await page.locator('input[readonly]').inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{40,}$/);

  const anonymous = await browser.newContext();
  const pub = await anonymous.newPage();
  await pub.goto(url);
  await expect(pub.getByRole('heading', { name: 'conteúdo público do snapshot' })).toBeVisible();
  await expect(pub.getByText('Resposta simulada (turno 1)')).toBeVisible();
  await expect(pub.getByText('somente leitura', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Revogar' }).click();
  await expect(page.getByText('revogado', { exact: false })).toBeVisible();
  await pub.reload();
  await expect(pub.getByText('Link indisponível')).toBeVisible();
  await anonymous.close();
});
