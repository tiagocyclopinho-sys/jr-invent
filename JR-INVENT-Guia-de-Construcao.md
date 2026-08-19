# Guia de Construção Passo a Passo — JR INVENT (Firebase + Vercel)

Este documento é o roteiro para construir a atualização dentro de uma IDE de código (Claude Code, VS Code, etc.). Ele parte do `jr-inventario-deploy-corrigido.zip` já analisado e das decisões fechadas no `JR-INVENT-Projeto-de-Atualizacao.md`.

**Premissas assumidas nesta versão** (avisar se algo precisar mudar):
- Backend: Firebase / Firestore (decisão #1).
- Sem tela de login — Admin inicia com nome + senha de atestado; Auditor só com nome (decisões #2 e #3).
- Leitor de código de barras fora do escopo inicial (decisão #5, parcial).
- **Suporte offline real desde esta versão** (decisão #4 fechada) — contagens feitas sem conexão ficam numa fila local e sincronizam sozinhas quando a rede voltar, usando a persistência offline nativa do Firestore (seção 5), sem precisar construir um mecanismo de fila do zero.
- Sem build tool/bundler — mantém a filosofia atual do projeto (HTML/CSS/JS puro), usando os módulos ESM do Firebase direto via CDN.

---

## 0. Ordem geral (visão rápida)

1. Contas e projeto no Firebase + Vercel
2. Estrutura de pastas
3. Modelo de dados no Firestore
4. Regras de segurança
5. Camada de dados (`data-service.js`)
6. Novo fluxo de identificação (sem login)
7. Contagem em tempo real + correção do corte de 150 itens
8. Itens não encontrados, itens fora do cadastro e busca
9. Melhorias de fluidez (salvar-e-avançar, feedback tátil)
10. Senha de atestado (divergência, finalização, reabertura)
11. Dashboard, relatórios e auditoria
12. Importação de planilha direto no navegador
13. Deploy na Vercel
14. Checklist final cruzando com os defeitos do plano original

---

## 1. Contas e projeto

1. Criar um projeto no [Firebase Console](https://console.firebase.google.com/).
2. Ativar **Firestore Database** (modo produção, região `southamerica-east1` para ficar perto do Brasil).
3. Em **Authentication → Sign-in method**, ativar **Anônimo**. Isso é só para o Firestore ter um `request.auth` válido nas regras de segurança (seção 4) — **não aparece nenhuma tela para o usuário**, o app faz login anônimo sozinho, em segundo plano, assim que abre.
4. Em **Configurações do projeto → Seus apps**, criar um app Web e copiar o objeto de configuração (`apiKey`, `authDomain`, `projectId` etc.). Essas chaves **não são secretas** no modelo do Firebase — a segurança real vem das regras do Firestore, não de esconder essas chaves.
5. Criar/conectar um projeto na [Vercel](https://vercel.com/) apontando para o repositório do JR INVENT.

---

## 2. Estrutura de pastas

**Remover** (não fazem mais sentido nesta arquitetura):
```
server.js
db_manager.js
netlify/
netlify.toml
_redirects
```

**Manter:**
```
index.html
app.js                 (reescrito — seção 6)
styles.css
manifest.json
sw.js                  (pequenos ajustes — seção 7)
icon.png, logos...
excel_cleaner.js        (mantém só a lógica de negócio, passa a receber linhas já lidas pelo SheetJS — seção 12)
```

**Criar:**
```
firebase-config.js       (inicialização do Firebase + login anônimo)
data-service.js          (camada única de acesso a dados — seção 5)
vercel.json               (config de deploy)
package.json               (formaliza o projeto, sem dependências de build)
firestore.rules             (regras de segurança)
```

`vercel.json`:
```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

`package.json` (mínimo, só para organizar — sem passo de build):
```json
{
  "name": "jr-invent",
  "version": "2.0.0",
  "private": true,
  "engines": { "node": ">=18" }
}
```

---

## 3. Modelo de dados no Firestore

Estrutura em coleções/subcoleções (equivalente às tabelas atuais do `db_manager.js`, sem a coleção de usuários/senha que existia para o login antigo):

```
inventories/{inventoryId}
  code: "INV-2026-002"
  name: "Inventário Geral"
  responsible: "Nome do Admin"
  adminPassword: "1234"          // atestado, não segurança — ver seção 10
  status: "Em andamento" | "Finalizado"
  isLocked: boolean
  scopeFilter: "Geral"
  itemsCount: number
  startDate, endDate, createdAt

inventories/{inventoryId}/items/{itemId}
  codigo, descricao, deposito
  quantidadeTeorica, quantidadeContada, diferenca   // quantidadeTeorica existe aqui, mas não aparece na tela de contagem — ver seção 7, item 8
  precoUltimaEntrada, custoMedio, valorTotal
  status: "nao_contado" | "em_contagem" | "sem_divergencia" | "divergencia"
  countStage, operator, countedAt, observacao
  adminJustification, adminApprovedBy, adminApprovedAt
  version

inventories/{inventoryId}/auditLogs/{logId}
  user, role, action, details, date, time, timestamp
```

Por que subcoleção por inventário (em vez de uma coleção `items` só, com `inventoryId` como campo, como é hoje no `db_manager.js`): evita precisar de índice composto para o filtro mais comum (todos os itens de UM inventário) e mantém a assinatura em tempo real (seção 7) simples — o app escuta só a subcoleção do inventário ativo.

---

## 4. Regras de segurança (`firestore.rules`)

Como não existe mais conceito de usuário/senha no nível do banco (a senha do Admin é só atestado de aplicação — seção 10), a regra só precisa garantir que quem escreve passou pelo login anônimo automático do passo 1.3:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /inventories/{inventoryId} {
      allow read, write: if request.auth != null;

      match /items/{itemId} {
        allow read, write: if request.auth != null;
      }
      match /auditLogs/{logId} {
        allow read, write: if request.auth != null;
      }
    }
  }
}
```

Publicar via Firebase Console (Firestore → Regras) ou `firebase deploy --only firestore:rules` se estiver usando a Firebase CLI.

---

## 5. Camada de dados (`data-service.js`)

Módulo único concentrando toda chamada ao Firestore — é o que deixa uma futura troca para Supabase restrita a este arquivo (combinado na seção 9 do plano). Antes das funções de dados, `firebase-config.js` precisa **ativar a persistência offline do Firestore** — é isso que resolve a fila offline (decisão #4) sem precisar montar um outbox manual em IndexedDB:

```js
// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const app = initializeApp(firebaseConfig);

// Ativa cache + fila de escrita offline nativos do Firestore.
// persistentMultipleTabManager evita conflito se o PWA ficar aberto em duas abas no mesmo aparelho.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export const auth = getAuth(app);
signInAnonymously(auth);
```

Com isso ativo, o Firestore passa a: (1) guardar localmente tudo que já foi lido via `onSnapshot`, então o app continua funcionando (mostrando os dados já carregados) mesmo sem rede; (2) guardar localmente qualquer escrita feita offline (`saveCount`, por exemplo) e reenviar sozinho assim que a conexão voltar — sem precisar de nenhum código extra de fila/retry.

Assinatura das funções a implementar em `data-service.js`:

```js
// data-service.js
export async function getActiveInventory() { }
export async function startInventory({ adminName, adminPassword, inventoryName, scopeFilter, excelFile }) { }
export async function joinAsAuditor({ name, inventoryId }) { }

export function subscribeToItems(inventoryId, onChange) { }        // onSnapshot — substitui o WebSocket manual
export function unsubscribeFromItems(inventoryId) { }
export function subscribeToAuditorJoins(inventoryId, onJoin) { }   // onSnapshot filtrado — usado só no dispositivo do Admin, seção 7

export async function saveCount(inventoryId, itemId, { quantidadeContada, operator, observacao, expectedVersion, naoEncontrado }) { }   // expectedVersion viabiliza o controle de conflito da seção 7, item 7; naoEncontrado é usado na seção 8
export async function addAdhocItem(inventoryId, { codigo, descricao, deposito, quantidadeContada, operator }) { }   // item físico sem cadastro prévio — seção 8
export async function approveDivergence(inventoryId, itemId, { quantidadeContada, justification, observacao, adminUser, adminPassword }) { }
export async function finalizeInventory(inventoryId, { adminUser, adminPassword }) { }
export async function reopenInventory(inventoryId, { adminUser, adminPassword }) { }

export async function getAuditLogs(inventoryId) { }
export async function getDashboardMetrics(inventoryId) { }   // leitura própria (getDocs), independente de subscribeToItems — mantém a tela de contagem dedicada só a contar, ver seção 11
```

Cada função de escrita (`saveCount`, `approveDivergence`, `finalizeInventory`, `reopenInventory`) também grava um documento em `auditLogs`, reaproveitando a mesma lógica que hoje está em `db_manager.js → addAuditLog()`. Enquanto o aparelho estiver offline, essas chamadas retornam imediatamente (a Promise do Firestore resolve otimisticamente) e ficam pendentes de envio até a rede voltar — não é preciso tratar isso como erro.

---

## 6. Novo fluxo de identificação (substitui o login)

No `index.html`:
1. Remover o bloco `#login-modal` inteiro (linhas 17–50 do arquivo atual).
2. Criar um novo modal `#start-modal` com dois estados internos (alternam por JS, não são duas telas separadas):
   - **Estado "Iniciar Inventário"**: campo Nome do Admin, campo Senha do Admin (`type="text"`, sem validação de força — seção 9 do plano), campo opcional de nome do inventário, botão de importar planilha (opcional, liga na seção 12), botão "Iniciar Inventário".
   - **Estado "Entrar como Auditor"**: campo Seu Nome, botão "Começar a Contar".

No `app.js`, a inicialização (`checkSession()` atual) passa a ser:
```js
async function init() {
  const saved = localStorage.getItem('jrinvent_session');
  if (saved) { /* pula direto para a contagem, como hoje */ }

  const activeInv = await getActiveInventory();
  if (activeInv) {
    showJoinAsAuditorForm(activeInv);
  } else {
    showStartInventoryForm();
  }
}
```

Ao confirmar qualquer um dos dois formulários, salvar em `localStorage` (`{ name, role, inventoryId }`, e a senha só se for Admin) e seguir para a tela de contagem — mesmo padrão de `applyUserSession()` que já existe hoje. `joinAsAuditor()` também grava um registro em `auditLogs` com `action: 'Entrada de Auditor'` — é esse registro que alimenta a notificação ao Admin descrita na seção 7.

---

## 7. Contagem em tempo real + correção do corte de 150 itens

1. Trocar `loadInventoryItems()` (que hoje faz `fetch('./api/inventories/.../items')`) por uma chamada a `subscribeToItems(inventoryId, (items) => { allItems = items; applyFiltersAndRender(); })`, chamada uma vez na entrada da tela de contagem.
2. **Remover** `setupWebSocket()`, `startPolling()` e toda a lógica de `ws`/`pollingInterval` — o `onSnapshot` do Firestore já entrega isso, com reconexão automática incluída (resolve o defeito #9 do plano original).
3. Em `renderProducts()`, remover o corte fixo (`Math.min(filteredItems.length, 150)`, defeito #3) e implementar renderização incremental: renderizar os primeiros ~60 itens e, ao chegar perto do fim da lista (scroll ou um botão "Carregar mais"), renderizar o próximo lote — sem limite total.
4. **Indicador de pendência offline:** dentro de `subscribeToItems`, usar `onSnapshot(query, { includeMetadataChanges: true }, ...)` e marcar cada item com `_pendingSync: doc.metadata.hasPendingWrites`. No card do produto (`renderProducts()`), mostrar um selo pequeno ("Pendente de envio") quando `_pendingSync` for `true` — assim o auditor sabe, olhando a lista, quais contagens ainda não saíram do aparelho.
5. **Status de conexão no cabeçalho:** o chip `#hdr-wifi-status` (que hoje é atualizado por `setWifiStatus()` a partir dos eventos do WebSocket) passa a refletir `snapshot.metadata.fromCache` — `true` quando os dados vêm só do cache local (sem contato com o servidor no momento), `false` quando confirmados pelo Firestore. Isso substitui o "Wi-Fi Online"/"Offline" caseiro de hoje por um indicador real de sincronização.
6. **Notificação ao Admin quando um auditor entra (validação de sincronia):** só no dispositivo do Admin, assinar `subscribeToAuditorJoins(inventoryId, onJoin)` e mostrar um aviso rápido na tela (toast/banner, ex. "🟢 Carlos Silva entrou no inventário") a cada novo evento — com `navigator.vibrate` opcional, mesmo padrão da seção 9. Além de avisar o Admin em tempo real, isso serve como **confirmação visual de que a sincronia entre aparelhos está funcionando de verdade**, sem precisar abrir o log de auditoria para conferir. Cuidado na implementação: o `onSnapshot` dispara imediatamente com todo o histórico já existente na primeira chamada — é preciso ignorar esse primeiro lote e só notificar entradas que chegarem depois da assinatura começar:
   ```js
   export function subscribeToAuditorJoins(inventoryId, onJoin) {
     let firstSnapshot = true;
     const q = query(
       collection(db, `inventories/${inventoryId}/auditLogs`),
       where('action', '==', 'Entrada de Auditor')
     );
     return onSnapshot(q, (snapshot) => {
       if (firstSnapshot) { firstSnapshot = false; return; }  // ignora o histórico já existente
       snapshot.docChanges().forEach((change) => {
         if (change.type === 'added') onJoin(change.doc.data());
       });
     });
   }
   ```
7. **Controle de conflito de escrita simultânea (resolve o defeito #4):** trocar o `update` direto de `saveCount()` por uma transação do Firestore (`runTransaction`). Ao abrir o modal de contagem, `openCountModal()` guarda o `version` do item naquele momento (`selectedItemExpectedVersion = item.version`). Ao salvar, a transação relê o item no servidor: se o `version` atual for diferente do que o app tinha quando o modal abriu, outro auditor já contou esse item nesse meio-tempo — a transação é abortada e o app mostra o valor mais recente em vez de sobrescrever silenciosamente, deixando o auditor decidir se confirma mesmo assim ou cancela. Sem conflito, a transação grava normalmente e incrementa o `version`:
   ```js
   export async function saveCount(inventoryId, itemId, { quantidadeContada, operator, observacao, expectedVersion }) {
     const itemRef = doc(db, `inventories/${inventoryId}/items/${itemId}`);
     return runTransaction(db, async (tx) => {
       const snap = await tx.get(itemRef);
       const current = snap.data();
       if (expectedVersion !== undefined && current.version !== expectedVersion) {
         const err = new Error('CONFLITO'); err.currentItem = current; throw err;
       }
       const diferenca = quantidadeContada - current.quantidadeTeorica;
       const status = diferenca === 0 ? 'sem_divergencia' : 'divergencia';
       tx.update(itemRef, {
         quantidadeContada, diferenca, operator, observacao, status,
         countStage: status === 'divergencia' ? 3 : 2,
         version: (current.version || 1) + 1
       });
     });
   }
   ```
   Complementar (prevenção, não só detecção): a opção "Indicador 'sendo contado agora'" da seção 6 do plano original — mostrar no card quando outro auditor tem aquele item aberto no modal agora — reduz a chance do conflito acontecer antes mesmo de alguém salvar.
8. **Ocultar a quantidade teórica na tela de contagem (contagem cega):** nem o card do produto (`renderProducts()`) nem o modal de contagem (`openCountModal()`) devem exibir `quantidadeTeorica` para quem está contando — hoje o modal mostra isso na linha "Saldo Teórico" e o card mostra "Teórico: X" junto de "Contado: X". Objetivo: a contagem tem que ser um número genuíno, digitado sem saber o valor esperado, para não condicionar o auditor a só repetir o que já está no sistema. O campo continua existindo no documento (necessário para calcular `diferenca`/`status` ao salvar) e continua aparecendo normalmente nas telas de uso do Admin — Divergências/3ª Contagem (onde comparar teórico x contado é o propósito da própria tela — se houver erro na contagem, é ali que o Admin confirma a quantidade correta, com a senha de atestado da seção 10), Dashboard e Relatórios. Depois de salvo, o card pode continuar mostrando "Contado: X" — é só o valor teórico que fica oculto, antes e depois da contagem, na tela principal.

   ⚠️ **Limite dessa proteção:** como as regras do Firestore (seção 4) só checam `request.auth != null`, sem restrição por campo, esconder `quantidadeTeorica` na tela impede o caso comum (auditor olhar a tela e copiar o número), mas não impede alguém tecnicamente capaz de inspecionar a resposta da rede diretamente. Vale deixar isso registrado para não passar a impressão de proteção à prova de tudo — na prática, esse nível é consistente com o padrão já adotado no resto do guia (senha do Admin como atestado, não como bloqueio de acesso).

---

## 8. Itens não encontrados, itens fora do cadastro e busca

Três situações que toda contagem física real enfrenta e que ainda não tinham lugar definido no guia.

**Itens não encontrados no depósito:** contar exige um valor numérico, mas fisicamente o auditor pode simplesmente não achar o produto no lugar indicado. Adicionar um botão dedicado no modal de contagem, ao lado de "💾 Salvar Contagem": **"❌ Não localizado"**. Ele grava a contagem com `quantidadeContada: 0` e uma flag própria `naoEncontrado: true`, com `status`/`countStage` calculados do mesmo jeito que uma contagem normal (se `quantidadeTeorica` for maior que zero, cai automaticamente em divergência e segue para a 3ª Contagem, exatamente como qualquer outra divergência). A diferença é só visual: o card e a lista de divergências mostram um selo "Não localizado" além do selo de divergência comum, para o Admin distinguir "duas pessoas contaram valores diferentes" de "o item simplesmente não estava lá".

```js
export async function saveCount(inventoryId, itemId, { quantidadeContada, operator, observacao, expectedVersion, naoEncontrado }) { }
```

**Fechar o inventário com itens pendentes:** sim, é permitido — mas não sem aviso. Antes de `finalizeInventory()` gravar, contar quantos itens ainda estão com `status === 'nao_contado'` (ninguém sequer tentou) e mostrar isso para o Admin: *"Ainda há 42 itens nunca contados. Finalizar mesmo assim?"*. Itens marcados como "Não localizado" **não entram nessa contagem** — eles já foram resolvidos (alguém procurou e não achou, e isso passou pela 3ª Contagem); só os que ninguém tocou é que geram o aviso. A confirmação usa a mesma senha de atestado da seção 10 — não bloqueia, só força uma decisão consciente em vez de fechar silenciosamente com itens esquecidos.

**Itens que existem no físico mas não no sistema:** acontece o contrário também — o auditor encontra um produto na prateleira que não está na planilha importada. Criar uma ação **"+ Item não cadastrado"** na tela de contagem (perto da busca), com um formulário simples: código (opcional), descrição, depósito, quantidade contada. Essa ação cria um item novo direto no Firestore com `quantidadeTeorica: 0` e `itemAvulso: true`:

```js
export async function addAdhocItem(inventoryId, { codigo, descricao, deposito, quantidadeContada, operator }) { }
// quantidadeTeorica: 0, diferenca: quantidadeContada, itemAvulso: true
// como teórico = 0, qualquer quantidade contada > 0 já cai em divergência automaticamente —
// reaproveita a 3ª Contagem existente, sem precisar de um fluxo de aprovação separado
```

Fica disponível para qualquer auditor (não precisa de senha do Admin) — o item entra como divergência normal, e é na 3ª Contagem que o Admin decide se aceita esse item "extra" no inventário oficial, com a mesma senha de atestado de sempre.

**Busca por qualquer parte do nome:** isso já existe hoje — `applyFiltersAndRender()` já filtra `codigo`, `descricao` e `deposito` com `.includes()` (substring, sem diferenciar maiúsculas/minúsculas) — e continua funcionando sem nenhuma mudança na nova arquitetura, porque a busca é 100% local sobre o array `allItems` já sincronizado (nunca dependeu de uma consulta ao servidor). Dois pontos para confirmar ao portar: (1) a busca continua filtrando sobre o array **completo**, não só o lote de ~60 itens renderizado pela paginação da seção 7, item 3 — a paginação é só de renderização, o filtro roda antes dela; (2) itens criados pelo "+ Item não cadastrado" usam os mesmos campos `codigo`/`descricao`/`deposito`, então já aparecem na busca automaticamente, sem ajuste extra.

---

## 9. Melhorias de fluidez

- **Salvar e ir para o próximo item** (opção 1 da seção 6 do plano): em `submitCount()`, depois de salvar com sucesso, em vez de só `closeCountModal()`, procurar o próximo item com `status === 'nao_contado'` na lista filtrada atual e já abrir `openCountModal()` para ele.
- **Feedback tátil/sonoro** (opção 2): logo após o `saveCount()` responder com sucesso, chamar `if (navigator.vibrate) navigator.vibrate(80)`.

---

## 10. Senha de atestado (divergência, finalização, reabertura)

Em `approveDivergence()`, `confirmFinalizeInventory()` e `submitReopenInventory()`, pedir a senha do inventário (comparando localmente com `inventory.adminPassword`, já carregado junto com o `activeInventory`) antes de chamar a função correspondente em `data-service.js`. **Sem nenhuma mensagem de "senha incorreta" bloqueando repetidamente** — é só um campo preenchido junto da ação, que fica registrado no `auditLogs` (`adminApprovedBy`, `adminUser`) como comprovação de quem executou.

---

## 11. Dashboard, relatórios e auditoria

Essas três abas (`tab-dashboard`, `tab-relatorios`, `tab-auditoria`) já existem no app atual e continuam fazendo sentido como estão — o que muda é só a fonte dos dados, não a interface.

**Dashboard (status e KPIs):** para manter a tela principal (`tab-contagem`) dedicada só à contagem, o Dashboard usa uma fonte de dados própria, separada da assinatura usada para contar (`subscribeToItems`). Em vez de recalcular a cada mudança feita por qualquer auditor, `getDashboardMetrics(inventoryId)` faz uma leitura independente (`getDocs`) da subcoleção de itens só quando a aba do Dashboard é aberta (`switchTab('tab-dashboard')`), calcula os KPIs a partir dela e pronto — sem manter nenhuma assinatura ativa em segundo plano nem competir por processamento com a contagem. Isso significa que o Dashboard mostra o estado de quando a aba foi aberta, não uma atualização contínua; um botão simples de "🔄 Atualizar" na própria aba cobre quem quiser dados mais recentes sem sair e voltar.

**Relatórios & Exportação (resultados):** `exportPDF()` (`window.print()`), `exportCSV()` e a tabela analítica (`loadReportsData()`) já são 100% client-side hoje, lendo direto de `allItems` — não precisam de nenhuma mudança de arquitetura, só continuam funcionando exatamente como estão, agora alimentados pelo array sincronizado via Firestore em vez do array vindo de `fetch`.

**Auditoria:** hoje `loadAuditLogs()` faz `fetch('./api/audit')`. Na nova versão, usar `getAuditLogs(inventoryId)` (seção 5), lendo a subcoleção `auditLogs` ordenada por `timestamp` decrescente. Vale deixar essa aba em tempo real também (mesmo padrão de `subscribeToItems`), já que o log está sendo alimentado o tempo todo por `saveCount`, `approveDivergence`, `joinAsAuditor` etc. — assim, quem estiver acompanhando a auditoria vê as entradas surgindo na hora, sem precisar sair e voltar na aba. Isso não conflita com a decisão do Dashboard: a auditoria tem sua própria assinatura (subcoleção `auditLogs`, separada de `items`), então não compete com a contagem do mesmo jeito.

**Conexão com a importação de planilha (seção 12):** como o `writeBatch` da importação grava em lotes de 500, e `subscribeToItems()` já está ativo assim que o inventário existe, os contadores da própria tela de contagem (badge de pendentes no cabeçalho, badge do menu lateral) já sobem em tempo real enquanto a planilha ainda está sendo importada — funciona como uma barra de progresso "de graça" para quem está na tela principal, sem precisar programar nada específico para isso. O Dashboard, por ser uma leitura separada (ver acima), só reflete o total mais recente depois de aberto (ou de um "Atualizar" manual).

---

## 12. Importação de planilha direto no navegador

Em vez de só adaptar o parser manual (`excel_cleaner.js`) para rodar no navegador, a melhor solução para o defeito #7 (parser frágil, com layout fixo) é trocar a leitura de baixo nível do arquivo por uma biblioteca real: **SheetJS (`xlsx`)**. Ela roda tanto no Node quanto no navegador sem precisar de bundler (expõe um global `XLSX` via `<script>` direto da CDN) e lida corretamente com múltiplas abas, células mescladas e variações de formato que o parser manual (unzip + regex em XML) não trata — e isso também elimina de vez o risco de bugs sutis de baixo nível (cabeçalho de dados comprimidos, descritores de dados no ZIP etc.) que o código atual carrega.

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
```

```js
async function parseExcelFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }); // array de arrays — mesma forma de entrada que cleanAndParseExcel já espera
  return cleanAndParseExcel(rows);
}
```

`cleanAndParseExcel` mantém a mesma lógica de negócio de hoje (forward-fill do Depósito, separação Código/Descrição, cálculo de valor total) — só passa a receber as linhas já extraídas pelo SheetJS em vez do buffer bruto do arquivo. As funções `unzipXlsx`, `parseSheetXml` e `parseSharedStrings` deixam de ser necessárias e podem ser removidas do `excel_cleaner.js`.

Duas melhorias adicionais para reduzir a fragilidade que sobra na lógica de negócio:
1. **Detectar colunas pelo nome do cabeçalho**, não pela posição fixa (A–F) — assim, se a planilha vier com colunas em outra ordem ou com uma coluna a mais, a importação continua funcionando.
2. **Tela de conferência antes de confirmar:** depois de parsear, mostrar um resumo (quantos itens foram encontrados, quantos depósitos distintos, quantos itens vieram com código ou descrição vazios) e só gravar no Firestore depois que o Admin confirmar — evita que um layout inesperado gere um inventário inteiro com dados errados sem ninguém perceber antes de começar a contagem física.

Ligar o resultado a `startInventory({ ..., excelFile })`, que grava os itens em lotes no Firestore (`writeBatch`, no máximo 500 operações por lote).

**Nota sobre importação offline:** como a persistência (seção 5) também guarda escritas em lote enfileiradas, importar uma planilha sem conexão funciona — mas para um inventário de ~1.500 itens isso significa uma fila grande esperando para sincronizar. Vale mostrar um aviso na tela ("Sem conexão — a importação será enviada assim que a rede voltar") em vez de deixar parecer que já terminou.

---

## 13. Deploy na Vercel

1. Subir o repositório atualizado (sem `server.js`/`netlify/`) para o GitHub/GitLab conectado à Vercel.
2. Em **Settings → Environment Variables** na Vercel, cadastrar as chaves do `firebase-config.js` (organização, não é passo de segurança).
3. Deploy automático a cada push (ou `vercel --prod` pela CLI).
4. **Teste obrigatório antes de liberar para a equipe:** abrir o app em dois aparelhos diferentes ao mesmo tempo, iniciar o inventário em um (como Admin), entrar como auditor no outro, e confirmar que o Admin recebe a notificação de entrada (seção 7, item 6) — essa notificação já serve como validação de que a sincronia está funcionando. Em seguida, contar um item no aparelho do auditor e confirmar que ele aparece atualizado no aparelho do Admin em poucos segundos, sem recarregar a página.

---

## 14. Checklist final — cruzando com os defeitos do plano original

| Defeito (do `JR-INVENT-Projeto-de-Atualizacao.md`) | Resolvido nesta construção? |
|---|---|
| #1 — Estado em memória não compartilhado (Netlify Functions) | ✅ Resolvido — Firestore é compartilhado de verdade |
| #2 — WebSocket não funciona no Netlify | ✅ Resolvido — `onSnapshot` substitui, com reconexão automática |
| #3 — Corte de 150 itens sem aviso | ✅ Resolvido — seção 7 |
| #4 — Sem controle de conflito de escrita simultânea | ✅ Resolvido — transação do Firestore (`runTransaction`) com checagem de `version` (seção 7, item 7): detecta quando dois auditores contam o mesmo item quase ao mesmo tempo e evita a sobrescrita silenciosa |
| #5 — Modo offline local cria inventário fictício que nunca sincroniza | ✅ Resolvido — persistência offline nativa do Firestore (seção 5): contagens feitas sem rede ficam na fila local do próprio banco e sincronizam sozinhas, sem inventário fictício nem dado preso no aparelho |
| #6 — Sem `package.json` | ✅ Resolvido — seção 2 |
| #7 — Parser de Excel frágil (layout fixo) | ✅ Resolvido — troca do parser manual por SheetJS (seção 12), detecção de colunas pelo nome do cabeçalho em vez de posição fixa, e tela de conferência antes de confirmar a importação |
| #8 — Reescrita do arquivo inteiro a cada contagem | ✅ Resolvido — Firestore grava só o documento alterado |
| #9 — WebSocket manual sem reconexão | ✅ Resolvido — `onSnapshot` |
| #10 — Comportamento offline inconsistente | ✅ Resolvido — um único mecanismo (persistência do Firestore) cobre leitura e escrita offline, com indicador visual de pendência (seção 7) em vez de dois comportamentos diferentes coexistindo |
| #11 — Código morto em `approveDivergence` | A corrigir ao portar a função para `data-service.js` (seção 5) |
| #12 — Credenciais visíveis na tela de login | ✅ Resolvido — tela de login removida |

---

## 15. Ordem recomendada de execução (resumo linear)

1. Seção 1 (contas) → 2 (pastas) → 3 (schema) → 4 (regras)
2. Seção 5 (`data-service.js`) — sem isso, nada mais funciona
3. Seção 6 (fluxo de identificação) → 7 (tempo real + lista completa) → 8 (não encontrados, fora do cadastro, busca)
4. Seção 10 (senha de atestado) → 9 (fluidez) → 11 (dashboard, relatórios e auditoria) → 12 (importação de planilha)
5. Seção 13 (deploy) → 14 (checklist)
