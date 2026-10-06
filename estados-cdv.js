// ── GRUPOS DE EMISSAO POR ESTADO (CDV) ───────────────────────────────────────
// Toda emissao que sai no grupo de emissoes do CDV tambem e copiada para o(s)
// grupo(s) do ESTADO de origem. E, quando a passagem e de ida e volta, a versao
// INVERTIDA (destino vira origem, volta vira ida) vai para o grupo do estado de
// destino: BH -> Sao Paulo sai em MG como esta e em SP como Sao Paulo -> BH.
//
// Este modulo e so regra e tabela (funcoes puras). Quem envia e o server.js
// (copiarEmissaoEstados), no mesmo ponto de saida da copia de executiva — um
// gancho so cobre radar, auto-envio, aba Emissao do gestor e agendamento.
//
// Regras da inversao (decididas em 06/10/2026):
//   - so-ida nao inverte: inverter inventaria um voo que ninguem encontrou;
//   - tarifa pagante nao inverte (o valor e texto livre e pode descrever o
//     sentido) — vai so para o estado de origem;
//   - domestico (origem e destino no Brasil): ida e volta SEMPRE inverte, com
//     as datas trocadas inteiras (cada trecho se emite separado);
//   - internacional: ida e volta so inverte se as datas fecharem: para quem sai do destino, a
//     ida passa a ser a lista de volta e a volta a lista de ida. Se toda volta
//     for anterior a toda ida, a viagem invertida e impossivel e nao sai;
//   - datas que nao dao para ler tambem nao invertem (na duvida, nao inventa);
//   - executiva entra normalmente (alem do grupo de executiva);
//   - mesmo estado nas duas pontas = uma copia so, a original.

// Siglas e nomes, para a tela montar o seletor (ordem alfabetica pelo nome).
export const UFS = [
  ['AC','Acre'], ['AL','Alagoas'], ['AP','Amapá'], ['AM','Amazonas'], ['BA','Bahia'],
  ['CE','Ceará'], ['DF','Distrito Federal'], ['ES','Espírito Santo'], ['GO','Goiás'],
  ['MA','Maranhão'], ['MT','Mato Grosso'], ['MS','Mato Grosso do Sul'], ['MG','Minas Gerais'],
  ['PA','Pará'], ['PB','Paraíba'], ['PR','Paraná'], ['PE','Pernambuco'], ['PI','Piauí'],
  ['RJ','Rio de Janeiro'], ['RN','Rio Grande do Norte'], ['RS','Rio Grande do Sul'],
  ['RO','Rondônia'], ['RR','Roraima'], ['SC','Santa Catarina'], ['SP','São Paulo'],
  ['SE','Sergipe'], ['TO','Tocantins'],
].map(([sigla, nome]) => ({ sigla, nome }))
 .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

export const SIGLAS_UF = UFS.map(u => u.sigla);

// Aeroportos brasileiros com voo comercial: codigo -> [UF, cidade(s)].
// A cidade vale como segunda chave porque a extracao nem sempre traz o codigo
// (a aba Emissao do gestor manda so o nome).
const AEROPORTOS_BR = {
  // AC
  RBR:['AC','Rio Branco'], CZS:['AC','Cruzeiro do Sul'],
  // AL
  MCZ:['AL','Maceió'],
  // AP
  MCP:['AP','Macapá'],
  // AM
  MAO:['AM','Manaus'], TBT:['AM','Tabatinga'], PIN:['AM','Parintins'],
  // BA
  SSA:['BA','Salvador'], BPS:['BA','Porto Seguro'], IOS:['BA','Ilhéus'],
  VDC:['BA','Vitória da Conquista'], LEC:['BA','Lençóis'], BRA:['BA','Barreiras'],
  TXF:['BA','Teixeira de Freitas'], PAV:['BA','Paulo Afonso'], FEC:['BA','Feira de Santana'],
  UNA:['BA','Una', 'Comandatuba'],
  // CE
  FOR:['CE','Fortaleza'], JDO:['CE','Juazeiro do Norte'], JJD:['CE','Jericoacoara', 'Cruz'],
  // DF
  BSB:['DF','Brasília'],
  // ES
  VIX:['ES','Vitória'],
  // GO
  GYN:['GO','Goiânia'], CLV:['GO','Caldas Novas'], RVD:['GO','Rio Verde'],
  // MA
  SLZ:['MA','São Luís'], IMP:['MA','Imperatriz'], BRB:['MA','Barreirinhas'],
  // MT
  CGB:['MT','Cuiabá'], ROO:['MT','Rondonópolis'], SMT:['MT','Sorriso'], OPS:['MT','Sinop'],
  AFL:['MT','Alta Floresta'], BPG:['MT','Barra do Garças'],
  // MS
  CGR:['MS','Campo Grande'], BYO:['MS','Bonito'], CMG:['MS','Corumbá'], DOU:['MS','Dourados'],
  // MG
  CNF:['MG','Belo Horizonte', 'Confins'], PLU:['MG','Belo Horizonte', 'Pampulha'],
  UDI:['MG','Uberlândia'], UBA:['MG','Uberaba'], MOC:['MG','Montes Claros'],
  IPN:['MG','Ipatinga', 'Vale do Aço'], IZA:['MG','Juiz de Fora', 'Zona da Mata'], JDF:['MG','Juiz de Fora'],
  GVR:['MG','Governador Valadares'], VAG:['MG','Varginha'], POJ:['MG','Patos de Minas'],
  POO:['MG','Poços de Caldas'], DIQ:['MG','Divinópolis'],
  // PA
  BEL:['PA','Belém'], STM:['PA','Santarém'], MAB:['PA','Marabá'], ATM:['PA','Altamira'],
  CKS:['PA','Parauapebas', 'Carajás'],
  // PB
  JPA:['PB','João Pessoa'], CPV:['PB','Campina Grande'],
  // PE
  REC:['PE','Recife'], PNZ:['PE','Petrolina'], FEN:['PE','Fernando de Noronha', 'Noronha'],
  CAU:['PE','Caruaru'],
  // PI
  THE:['PI','Teresina'], PHB:['PI','Parnaíba'],
  // PR
  CWB:['PR','Curitiba'], IGU:['PR','Foz do Iguaçu'], LDB:['PR','Londrina'], MGF:['PR','Maringá'],
  CAC:['PR','Cascavel'], PGZ:['PR','Ponta Grossa'], GPB:['PR','Guarapuava'], TOW:['PR','Toledo'],
  // RJ
  GIG:['RJ','Rio de Janeiro', 'Rio', 'Galeão'], SDU:['RJ','Rio de Janeiro', 'Santos Dumont'],
  CFB:['RJ','Cabo Frio'], MEA:['RJ','Macaé'], CAW:['RJ','Campos dos Goytacazes'],
  // RN
  NAT:['RN','Natal'], MVF:['RN','Mossoró'],
  // RS
  POA:['RS','Porto Alegre'], CXJ:['RS','Caxias do Sul'], PFB:['RS','Passo Fundo'],
  RIA:['RS','Santa Maria'], PET:['RS','Pelotas'], URG:['RS','Uruguaiana'], GEL:['RS','Santo Ângelo'],
  // RO
  PVH:['RO','Porto Velho'], JPR:['RO','Ji-Paraná'], OAL:['RO','Cacoal'], BVH:['RO','Vilhena'],
  // RR
  BVB:['RR','Boa Vista'],
  // SC
  FLN:['SC','Florianópolis', 'Floripa'], NVT:['SC','Navegantes'], JOI:['SC','Joinville'],
  XAP:['SC','Chapecó'], JJG:['SC','Jaguaruna'], CCM:['SC','Criciúma'], LAJ:['SC','Lages'],
  // SP
  GRU:['SP','São Paulo', 'Guarulhos'], CGH:['SP','São Paulo', 'Congonhas'],
  VCP:['SP','Campinas', 'Viracopos'], RAO:['SP','Ribeirão Preto'], SJP:['SP','São José do Rio Preto'],
  JTC:['SP','Bauru'], PPB:['SP','Presidente Prudente'], MII:['SP','Marília'], AQA:['SP','Araraquara'],
  SJK:['SP','São José dos Campos'], ARU:['SP','Araçatuba'],
  // SE
  AJU:['SE','Aracaju'],
  // TO
  PMW:['TO','Palmas'], AUX:['TO','Araguaína'],
};

// Grafias que aparecem nos alertas e nao batem com o nome da tabela.
const APELIDOS_CIDADE = {
  'bh': 'MG', 'belo horizonte confins': 'MG',
  'sp': 'SP', 'sao paulo guarulhos': 'SP', 'sao paulo congonhas': 'SP',
  'rj': 'RJ', 'rio de janeiro galeao': 'RJ',
  'brasilia df': 'DF', 'florianopolis navegantes': 'SC', 'floripa navegantes': 'SC',
  'joao pessoa campina grande': 'PB',
};

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[.]/g, '').replace(/[\/()\-–]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const UF_POR_CIDADE = (function () {
  const m = { ...APELIDOS_CIDADE };
  for (const [uf, ...cidades] of Object.values(AEROPORTOS_BR)) {
    for (const c of cidades) {
      const k = normalizar(c);
      if (!m[k]) m[k] = uf;
    }
  }
  return m;
})();

/**
 * Estado brasileiro de uma ponta da viagem. Codigo IATA primeiro (e exato);
 * sem codigo, o nome da cidade. Fora do Brasil ou desconhecido -> null.
 */
export function ufDoLocal(codigo, nome) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(cod) && AEROPORTOS_BR[cod]) return AEROPORTOS_BR[cod][0];
  const k = normalizar(nome);
  if (!k) return null;
  if (UF_POR_CIDADE[k]) return UF_POR_CIDADE[k];
  // "Belo Horizonte (CNF)" / "São Paulo - GRU": o codigo entre parenteses ou
  // depois do traco decide.
  const m = String(nome || '').toUpperCase().match(/\b([A-Z]{3})\b/g);
  if (m) for (const c of m) if (AEROPORTOS_BR[c]) return AEROPORTOS_BR[c][0];
  return null;
}

function ehPagante(d) {
  return String((d && d.tarifa) || '').trim().toLowerCase() === 'pagante';
}

/**
 * A viagem invertida existe? `extrairDatasISO` vem do server.js para nao haver
 * uma segunda copia do leitor de datas. Devolve { ok, motivo }.
 */
export function podeInverter(d, extrairDatasISO, domestico) {
  if (!d) return { ok: false, motivo: 'sem dados' };
  if (ehPagante(d)) return { ok: false, motivo: 'tarifa pagante' };
  const volta = String(d.datasVolta || '').trim();
  if (!volta || volta === '-') return { ok: false, motivo: 'so ida' };
  // Domestico (as duas pontas no Brasil): cada trecho se emite separado, entao
  // a invertida sai sempre, com as listas de datas trocadas inteiras — quem
  // sai do destino pode comprar so um trecho (decisao de 06/10/2026).
  if (domestico) return { ok: true, motivo: '' };
  const idas   = extrairDatasISO(d.datasIda);
  const voltas = extrairDatasISO(d.datasVolta);
  if (!idas.length || !voltas.length) return { ok: false, motivo: 'datas ilegiveis' };
  // Internacional — invertida: ida' = voltas, volta' = idas. Precisa de alguma volta' (ida
  // original) no mesmo dia ou depois de alguma ida' (volta original).
  if (idas[idas.length - 1] < voltas[0]) return { ok: false, motivo: 'datas nao fecham ao inverter' };
  // So as datas que formam viagem: ida' ate a ultima volta', volta' a partir
  // da primeira ida'. O resto nao serve para quem sai do outro lado.
  const novaIda   = voltas.filter(v => v <= idas[idas.length - 1]);
  const novaVolta = idas.filter(i => i >= novaIda[0]);
  return { ok: true, motivo: '', datasIda: novaIda, datasVolta: novaVolta };
}

const MESES_ABREV = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

/** ['2026-11-03','2026-11-05','2026-12-01'] -> 'Nov/26: 3, 5 Dez/26: 1' (formato das mensagens). */
export function datasISOParaTexto(lista) {
  const porMes = new Map();
  for (const iso of lista || []) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const k = MESES_ABREV[+m[2] - 1] + '/' + m[1].slice(2);
    if (!porMes.has(k)) porMes.set(k, []);
    porMes.get(k).push(+m[3]);
  }
  return [...porMes.entries()].map(([k, dias]) => k + ': ' + dias.join(', ')).join(' ');
}

/**
 * Dados da viagem no sentido contrario. Nao altera o objeto recebido. Com
 * `datas` (saida de podeInverter) as listas saem filtradas para o que forma
 * viagem; sem elas, so trocadas.
 */
export function inverterDados(d, datas) {
  const inv = { ...d };
  inv.origem       = d.destino;
  inv.destino      = d.origem;
  inv.origemCodigo = d.destinoCodigo;
  inv.destinoCodigo = d.origemCodigo;
  inv.datasIda     = d.datasVolta;
  inv.datasVolta   = d.datasIda;
  if (datas && datas.datasIda && datas.datasIda.length && datas.datasVolta && datas.datasVolta.length) {
    inv.datasIda   = datasISOParaTexto(datas.datasIda);
    inv.datasVolta = datasISOParaTexto(datas.datasVolta);
  }
  // "102000 (ida) / 86600 (volta)" troca de rotulo junto com o sentido.
  if (typeof d.pontos === 'string') {
    inv.pontos = d.pontos.replace(/\((ida|volta)\)/gi, (_, w) => w.toLowerCase() === 'ida' ? '(volta)' : '(ida)');
  }
  for (const k of Object.keys(inv)) if (inv[k] === undefined) delete inv[k];
  return inv;
}

/**
 * Plano de copias de uma emissao.
 *   dados     — dados estruturados da emissao (origem, destino, datas...)
 *   grupos    — [{ uf, jid, ativo }] cadastrados na config
 *   reservados — JIDs que nunca recebem copia (emissao, executiva...)
 * Devolve { copias: [{ jid, uf, tipo:'original'|'invertida', dados }], ufOrigem,
 *           ufDestino, inversao:{ ok, motivo } }.
 */
export function planejarCopiasEstado(dados, grupos, reservados, extrairDatasISO) {
  const d = dados || {};
  const ativos = (grupos || []).filter(g => g && g.ativo !== false && g.jid);
  const bloq = new Set((reservados || []).filter(Boolean));
  const ufOrigem  = ufDoLocal(d.origemCodigo,  d.origem);
  const ufDestino = ufDoLocal(d.destinoCodigo, d.destino);
  const usados = new Set();
  const copias = [];
  const jidsDe = (uf) => ativos.filter(g => g.uf === uf).map(g => g.jid);

  if (ufOrigem) {
    for (const jid of jidsDe(ufOrigem)) {
      if (bloq.has(jid) || usados.has(jid)) continue;
      usados.add(jid);
      copias.push({ jid, uf: ufOrigem, tipo: 'original', dados: d });
    }
  }

  let inversao = { ok: false, motivo: 'destino sem estado' };
  if (ufDestino && ufDestino === ufOrigem) {
    inversao = { ok: false, motivo: 'mesmo estado' };
  } else if (ufDestino) {
    const alvos = jidsDe(ufDestino).filter(j => !bloq.has(j) && !usados.has(j));
    if (!alvos.length) {
      inversao = { ok: false, motivo: 'estado ' + ufDestino + ' sem grupo' };
    } else {
      inversao = podeInverter(d, extrairDatasISO, !!ufOrigem);
      if (inversao.ok) {
        const inv = inverterDados(d, inversao);
        for (const jid of alvos) {
          usados.add(jid);
          copias.push({ jid, uf: ufDestino, tipo: 'invertida', dados: inv });
        }
      }
    }
  }
  return { copias, ufOrigem, ufDestino, inversao };
}

/**
 * Origem e destino tirados do titulo da mensagem ("*Belo Horizonte - Sao
 * Paulo por ..."), para envio antigo sem dados estruturados. Nunca inverte.
 */
export function rotaDoTitulo(mensagem) {
  const linha = String(mensagem || '').split('\n').find(l => l.trim()) || '';
  const m = linha.replace(/^\*+/, '').match(/^\s*([^*\n]+?)\s+-\s+([^*\n]+?)(?:\s+(?:por|em)\s|\*|$)/i);
  if (!m) return null;
  return { origem: m[1].trim(), destino: m[2].trim() };
}
