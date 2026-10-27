// Developer-only: reads the web reference and writes fixtures here. Never edits the web.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web=resolve(process.argv[2] ?? resolve(root,'../camscanner2'));
const require=createRequire(resolve(web,'package.json'));
const {build}=require('esbuild');
const module=await build({stdin:{contents:`
 export {warpPerspectiveRgba} from './src/imaging/rendering/perspective-warp';
 export {applyDocumentFilter} from './src/imaging/rendering/document-filter';
 export {analyzeDocumentQuality} from './src/imaging/analysis/document-quality';
 `,resolveDir:web,loader:'ts'},bundle:true,format:'esm',platform:'node',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(module.outputFiles[0].text).toString('base64'));
const out=resolve(root,'tests/golden');mkdirSync(out,{recursive:true});
const ppm=(name,image)=>{
 const rgb=Buffer.alloc(image.dimensions.width*image.dimensions.height*3);
 for(let i=0;i<rgb.length/3;i++)for(let c=0;c<3;c++)rgb[i*3+c]=image.pixels[i*4+c];
 writeFileSync(resolve(out,name),Buffer.concat([Buffer.from(`P6\n${image.dimensions.width} ${image.dimensions.height}\n255\n`),rgb]));
};
const make=(color=false)=>{
 const width=169,height=123,pixels=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*4;
  let gray=95+Math.round(x/width*85+y/height*30);
  if(y%17<2 && x>12 && x<145)gray-=30;
  if(x>35&&x<40)gray=35;
  pixels.set(color?[gray,Math.max(0,gray-35),Math.min(255,gray+25),255]:[gray,gray,gray,255],i);
 }
 return {dimensions:{width,height},pixels};
};
const lines=[];
for(const [name,color] of [['neutral',false],['color',true]]){
 const source=make(color);ppm(name+'.ppm',source);
 const q=api.analyzeDocumentQuality(source);
 for(const [suffix,strengths] of Object.entries({appearance:{shadow:.6,lift:.4,contrast:.35,sharpen:0,smooth:0},detail:{shadow:0,lift:0,contrast:0,sharpen:.7,smooth:.2}})){
  for(const [mode,number] of [['ocr-color',1],['enhanced-color',2],['grayscale',3],['black-and-white',4]]){
   const copy={dimensions:source.dimensions,pixels:source.pixels.slice()};
   const expected=api.applyDocumentFilter(copy,mode,{quality:q,protectColor:color,strengths});
   const id=name+'-'+suffix+'-'+number;ppm(id+'.ppm',expected);
   lines.push([id,name+'.ppm',id+'.ppm','filter',number,+color,...Object.values(strengths),q.brightness.mean,q.brightness.darkPercentile,q.brightness.brightPercentile,q.illumination.darkLevel,q.illumination.brightLevel,q.detail.edgeScore,q.detail.periodicRatio].join(' '));
  }
 }
}
for (const [name,color,kind] of [['soft-ink',false,'soft'],['color-soft-ink',true,'soft'],['faint-ink',false,'faint'],['faint-structured',false,'structured'],['paper-noise',false,'noise']]) {
 const width=169,height=123,pixels=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const levels=[230,230,220,170,100,80,100,170,220];
  const v=kind==='soft'?(levels[x%24]??230):kind==='faint'?(x%24===8?200:220):kind==='structured'?(x%16<2?200:220):210+((x+y)%2===0?3:-3);
  pixels.set(color?[v+10,v,v-10,255]:[v,v,v,255],(y*width+x)*4);
 }
 const source={dimensions:{width,height},pixels}, q=api.analyzeDocumentQuality(source);
 ppm(name+'.ppm',source);
 const expected=api.applyDocumentFilter({dimensions:source.dimensions,pixels:source.pixels.slice()},'enhanced-color');
 ppm(name+'-enhanced.ppm',expected);
 lines.push([name,name+'.ppm',name+'-enhanced.ppm','filter',2,+color,0,0,0,0,0,q.brightness.mean,q.brightness.darkPercentile,q.brightness.brightPercentile,q.illumination.darkLevel,q.illumination.brightLevel,q.detail.edgeScore,q.detail.periodicRatio].join(' '));
}
for(const [name,corners,max] of [['perspective',[[20,12],[145,5],[136,114],[9,101]],1000],['reduced',[[20,12],[145,5],[136,114],[9,101]],64],['identity',[[0,0],[169,0],[169,123],[0,123]],1000]]){
 const source=make(true);const quad=corners.map(([x,y])=>({x,y}));
 const expected=api.warpPerspectiveRgba(source,quad,max);ppm(name+'.ppm',expected);
 lines.push([name,'color.ppm',name+'.ppm','warp',max,...corners.flat()].join(' '));
}
writeFileSync(resolve(out,'cases.txt'),lines.join('\n')+'\n');
console.log(JSON.stringify(qShape(),null,2));
function qShape(){return api.analyzeDocumentQuality(make(false));}
