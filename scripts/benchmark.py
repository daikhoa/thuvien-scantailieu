"""Local timing/RSS benchmark; includes ctypes input-copy overhead, not phone measurements."""
import argparse, gc, io, json, platform, statistics, sys, time
from pathlib import Path
import psutil
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT / "examples"))
from docscan import Library
parser=argparse.ArgumentParser()
parser.add_argument("library")
parser.add_argument("--output",default="build/benchmark.json")
args=parser.parse_args()
lib=Library(args.library)
results=[]
with lib.engine(lib.config(ROOT / "models")) as engine:
    for width,height in ((4000,3000),(8000,6000)):
        image=Image.new("RGB",(width,height),(230,225,218))
        draw=ImageDraw.Draw(image)
        for y in range(100,height-100,80):
            draw.line((100,y,width-100,y),fill=(45,40,38),width=3)
        stream=io.BytesIO()
        image.save(stream,"JPEG",quality=98,subsampling=0)
        encoded=stream.getvalue()
        del image,draw,stream
        gc.collect()
        for mode in (0,1,2,4):
            samples=[]
            for repeat in range(4):
                options=lib.options(filter=mode,crop_mode=1)
                before=psutil.Process().memory_info().rss
                start=time.perf_counter()
                with engine.document() as doc:
                    doc.add(encoded,options)
                    info,jpeg=doc.page(0)
                    pdf=doc.pdf()
                    rss=psutil.Process().memory_info().rss
                elapsed=(time.perf_counter()-start)*1000
                samples.append({"total_ms":round(elapsed,2),"decode_ms":round(info.decode_ms,2),
                    "analyze_ms":round(info.analyze_ms,2),"warp_ms":round(info.warp_ms,2),
                    "filter_ms":round(info.filter_ms,2),"encode_ms":round(info.encode_ms,2),
                    "rss_before_mib":round(before/1048576,1),"rss_after_mib":round(rss/1048576,1)})
            results.append({"source":[width,height],"filter":mode,"output":[info.width,info.height],
                "jpeg_bytes":len(jpeg),"pdf_bytes":len(pdf),"warm_median_ms":round(statistics.median(s["total_ms"] for s in samples[1:]),2),"samples":samples})
            print(results[-1]["source"],mode,results[-1]["warm_median_ms"],"ms")
report={"platform":platform.platform(),"python":platform.python_version(),"cpu":platform.processor(),
    "notes":"Release, CPU, one ORT thread; source decode full resolution, output max3000. Timings include ctypes copy and PDF. RSS snapshots are not peak memory. Warm median excludes first call. No JS/phone comparison.","results":results}
Path(args.output).write_text(json.dumps(report,indent=2),encoding="utf-8")
