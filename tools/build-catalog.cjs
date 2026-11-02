// Fonte oficial: tensorflow/tfjs-models/mobilenet/src/imagenet_classes.ts (Apache-2.0).
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
// Entrada é o TypeScript oficial baixado separadamente. A geração não executa código dessa fonte.
const catalogo = {};
const traduzidos = { 7:'Galinha',8:'Galinha',9:'Avestruz',99:'Ganso',100:'Cisne',281:'Gato',282:'Gato',283:'Gato',284:'Gato',285:'Gato',286:'Onça-parda',287:'Lince',288:'Leopardo',289:'Leopardo-das-neves',290:'Onça-pintada',291:'Leão',292:'Tigre',293:'Guepardo',330:'Coelho',331:'Lebre',332:'Coelho',333:'Hamster',338:'Porquinho-da-índia',339:'Cavalo',340:'Zebra',341:'Suíno',342:'Javali',343:'Facóquero',344:'Hipopótamo',345:'Bovino',346:'Búfalo',347:'Bisão',348:'Ovino',350:'Íbex',354:'Dromedário',355:'Lhama',385:'Elefante-indiano',386:'Elefante-africano' };
// Lê rótulos, incluindo strings concatenadas, e associa seus IDs às espécies do projeto.
for (const match of source.matchAll(/^\s*(\d+):\s*((?:'(?:[^'\\]|\\.)*'\s*(?:\+\s*)?)+),/gm)) {
  const id = Number(match[1]); if (id > 397) continue;
  const original = [...match[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\'/g,"'").replace(/\\\\/g,'\\')).join('');
  let especie = traduzidos[id] || original.split(',')[0], raca = 'Não identificada';
  // O intervalo contém raças de cães. Padrões de pelagem felinos não são tratados como raça.
  if (id >= 151 && id <= 268) { especie = 'Cachorro'; raca = original.split(',')[0]; }
  if (id === 283) raca = 'Persa';
  if (id === 284) raca = 'Siamês';
  if (id === 285) raca = 'Mau egípcio (sugestão visual)';
  if (id === 332) raca = 'Angorá';
  if (id === 97 || id === 98) especie = 'Pato';
  if (id === 348) especie = 'Ovelha';
  if (['Cachorro','Gato','Cavalo','Bovino','Ovelha','Galinha','Pato','Ganso'].includes(especie)) {
    catalogo[id] = { especie, raca };
  }
}
// Interrompe se o formato/IDs oficiais mudar; não publica silenciosamente um catálogo incompleto.
if (Object.keys(catalogo).length !== 131) throw new Error('Formato inesperado no catálogo oficial.');
fs.writeFileSync('catalogo.json', JSON.stringify(catalogo, null, 2) + '\n');
console.log('Catálogo gerado: oito espécies, 131 classes do modelo.');
