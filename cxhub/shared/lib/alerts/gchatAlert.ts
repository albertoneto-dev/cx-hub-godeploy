import { formatAlert } from './formatAlert';
import { ALERT_POLICY, deveAvisar } from './policy';
import type { AlertContext } from './types';

/**
 * Transporte do aviso para o **Slack** (Incoming Webhook em `SLACK_ALERT_WEBHOOK_URL`, o mesmo canal dos avisos da
 * fila). O nome do arquivo ficou do CX Hub na Vercel, onde o aviso ia ao Google Chat; o texto (`formatAlert`) é o
 * mesmo, porque o `*negrito*` e o `_itálico_` dele valem igual no mrkdwn do Slack.
 *
 * **A propriedade que importa aqui não é "consegue enviar" — é NUNCA LANÇAR E NUNCA TRAVAR** (ADR-005
 * §4, candidato a INV-06). Webhook fora do ar, env var ausente, corpo recusado, timeout: tudo devolve
 * `false` e segue a vida. Perder a solicitação por causa do mecanismo que existe para avisar que ela se
 * perdeu seria absurdo — e é exatamente o tipo de erro que um `await` desavisado introduz.
 *
 * Por isso também **não** usamos promessa solta (fire-and-forget): em serverless a plataforma pode
 * matar o processo depois da resposta, e o aviso nunca sairia. O envio é aguardado, com timeout curto e
 * próprio, **depois** de a linha já estar gravada.
 */

const LOG = '[Alerta]';

/**
 * Curto de propósito: o aviso não pode empurrar o handler para o teto de duração.
 *
 * Exportado porque o route handler **conta com ele** ao dimensionar o orçamento da fase Cosmos — se este
 * número mudar sem o outro saber, o pior caso volta a estourar o `maxDuration`.
 */
export const ALERT_TIMEOUT_MS = 2500;

/**
 * Janela do anti-ruído. Ver a limitação honesta no ADR-005 (best-effort em memória). Lida a cada aviso, não na carga
 * do módulo: no Worker o `process.env` só é preenchido quando a requisição chega.
 */
const throttleMs = (): number => parseInt(process.env.ALERT_THROTTLE_MS || '', 10) || 15 * 60_000;

/** Teto do erro do Slack no log: no erro ele responde texto curto (`no_service`, `invalid_payload`, `channel_is_archived`). */
const MAX_ERRO_DO_SLACK = 100;

/**
 * O Slack lê `<...>` como link ou menção (`<!channel>` chamaria o canal inteiro) e `&` como começo de entidade. O
 * `motivo`, o `detalhe` e as `tentativas` podem trazer texto do ERP: o card vai com os três escapados.
 */
const escaparParaSlack = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Estado de módulo: uma instância de servidor lembra o que já avisou.
 *
 * **Limitação assumida, não esquecida:** em serverless multi-instância isto NÃO é janela global — duas
 * instâncias podem avisar a mesma causa. O pior caso é aviso repetido; nunca aviso perdido. Trocar por
 * estado compartilhado exigiria infraestrutura que esta fatia não justifica.
 */
const ultimoAviso = new Map<string, { quando: number; sistemica: boolean }>();

/**
 * Teto de entradas antes da poda. Existe porque as causas com `agrupar: false` compõem a chave com o
 * `numeroPedido` — cardinalidade **ilimitada** numa instância que o Fluid Compute reusa entre
 * requisições. O ADR-005 assume o best-effort da janela em multi-instância; não assume crescimento sem
 * limite.
 */
const MAX_CHAVES_THROTTLE = 500;

/** Descarta o que já saiu da janela — entrada expirada não agrupa mais nada, só ocupa memória. */
function podar(agora: number): void {
    if (ultimoAviso.size < MAX_CHAVES_THROTTLE) return;
    const janela = throttleMs();
    for (const [chave, registro] of ultimoAviso) {
        if (agora - registro.quando >= janela) ultimoAviso.delete(chave);
    }
    // Expirar não libera **nada** quando todas as chaves estão DENTRO da janela — e é exatamente aí
    // que o `Map` cresceria sem teto numa instância que o Fluid Compute reusa entre requisições. O
    // `Map` itera na ordem de inserção, então o primeiro do laço é o mais antigo.
    //
    // **O descarte só recai sobre as chaves POR PEDIDO**, e essa assimetria é o conserto: a
    // cardinalidade ilimitada vem delas (uma por pedido), enquanto as sistêmicas são no máximo uma por
    // `AlertReason` — um punhado fixo. Sem a distinção, a chave sistêmica era sempre a **primeira**
    // descartada numa rajada: ela é, por construção, a mais antiga (armada uma vez, agrupando desde
    // então). Ou seja, a poda reemitia justamente o card que o agrupamento existe para conter (RF-42).
    for (const [chave, registro] of ultimoAviso) {
        if (ultimoAviso.size < MAX_CHAVES_THROTTLE) break;
        if (!registro.sistemica) ultimoAviso.delete(chave);
    }
}

/** Só para teste — `ultimoAviso` é estado de módulo e vazaria entre casos. */
export function __resetAlertThrottle(): void {
    ultimoAviso.clear();
}

/**
 * Chave do agrupamento. Causa **sistêmica** agrupa por causa (100 pedidos parados pela mesma
 * transportadora fora do mapa é **um** problema); causa individualmente acionável agrupa por
 * causa+pedido, para que cada pedido apareça mas a repetição do mesmo não faça barulho.
 *
 * **Sem pedido no contexto, cai no `reason` puro** (RF-42). Compor a chave com o `requestId` — que é
 * um UUID novo a cada requisição — é o mesmo que não agrupar, e o caso onde isso acontece é o
 * `INTERNAL_ERROR` do catch geral: um bug nosso em todo payload mandaria **um card por requisição**
 * justamente na falha sistemática que a política existe para conter. O `requestId` segue no card,
 * apontando para o log da Vercel.
 */
function chaveThrottle(ctx: AlertContext): { chave: string; sistemica: boolean } {
    if (ALERT_POLICY[ctx.reason].agrupar || !ctx.numeroPedido) {
        // `sistemica` viaja junto porque a **poda** precisa dela: é o que impede a chave de vida longa
        // de ser descartada por uma rajada de chaves por pedido (ver `podar`).
        // `agruparPor` abre a causa em sub-grupos fixos (uma marca por vez), sem virar chave por pedido.
        return { chave: ctx.agruparPor ? `${ctx.reason}:${ctx.agruparPor}` : ctx.reason, sistemica: true };
    }
    return { chave: `${ctx.reason}:${ctx.numeroPedido}`, sistemica: false };
}

/**
 * Envia o aviso, se ele deve ser enviado.
 *
 * @returns `true` só quando o Slack aceitou. `false` cobre tudo o mais — não avisável, sem
 * configuração, agrupado ou falhou. **Nunca lança.**
 */
export async function sendAlert(ctx: AlertContext): Promise<boolean> {
    try {
        if (!deveAvisar(ctx.reason)) {
            return false;
        }

        const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL?.trim();
        if (!webhookUrl) {
            // Não é erro: um ambiente sem o webhook configurado (dev, preview) segue funcionando
            // igual. O aviso é observabilidade, não parte do fluxo.
            console.warn(`${LOG} SLACK_ALERT_WEBHOOK_URL ausente — aviso não enviado:`, ctx.reason);
            return false;
        }

        const politica = ALERT_POLICY[ctx.reason];
        // O crítico nunca é agrupado: cada violação do modo de teste é um evento próprio.
        if (politica.severidade !== 'critica') {
            const { chave, sistemica } = chaveThrottle(ctx);
            const agora = Date.now();
            const anterior = ultimoAviso.get(chave);
            if (anterior !== undefined && agora - anterior.quando < throttleMs()) {
                console.log(`${LOG} Agrupado na janela (${ctx.reason}) — aviso não reenviado`);
                return false;
            }
            podar(agora);
            // `delete` antes do `set`: `Map.set` em chave existente **preserva** a posição de inserção,
            // então rearmar sem apagar deixaria a chave envelhecendo na fila da poda para sempre.
            ultimoAviso.delete(chave);
            ultimoAviso.set(chave, { quando: agora, sistemica });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
        try {
            const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ text: escaparParaSlack(formatAlert(ctx)) }),
                signal: controller.signal,
            });

            if (!res.ok) {
                // O status e o erro curto do Slack, nunca a URL: quem tem a URL do webhook posta no
                // canal, e o log do app é lido por mais gente.
                let erroDoSlack = '';
                try {
                    erroDoSlack = (await res.text()).trim().slice(0, MAX_ERRO_DO_SLACK);
                } catch {
                    // Sem corpo legível: fica só o status.
                }
                console.error(`${LOG} O Slack recusou o aviso: HTTP ${res.status}${erroDoSlack ? ` (${erroDoSlack})` : ''} (${ctx.reason})`);
                return false;
            }

            return true;
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (error) {
        // O catch mais importante do arquivo: daqui não sai exceção, em nenhuma circunstância.
        console.error(
            `${LOG} Falha ao enviar aviso (${ctx.reason}):`,
            error instanceof Error ? error.message : 'erro desconhecido'
        );
        return false;
    }
}
