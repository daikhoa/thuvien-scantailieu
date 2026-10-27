#include "pixels.hpp"
#include <algorithm>
namespace docscan {
namespace {
double unit(double x) {
    return std::clamp(x, 0.0, 1.0);
}
} // namespace
Plan make_plan(const std::array<double, 7> &scores, const Quality &q) {
    Plan p;
    p.quality = q;
    p.protect_color = scores[6] >= .6 || q.color;
    const double safe = 1 - unit(q.highlight / .55), blur = unit((18 - q.edge) / 18);
    p.shadow = std::max(unit((scores[0] - .35) / .55), unit((q.illumination - 45) / 90) * .4) *
               unit((q.illumination - 18) / 80) * safe;
    p.lift = unit((215 - q.mean) / 140) * safe * (p.protect_color ? .15 : .65);
    p.contrast = unit((scores[5] - .3) / .6) * unit((28 - q.contrast) / 28) * unit(q.edge / 2) *
                 (p.protect_color ? .3 : .6);
    p.sharpen = q.edge >= 42 ? 0 : unit((scores[2] - .3) / .6) * blur * (p.protect_color ? .4 : .8);
    p.smooth = unit((scores[3] - .45) / .5) * unit((q.periodic - .03) / .12) * (q.edge >= 42 ? .08 : .25);
    if (scores[4] >= .75)
        p.warnings |= DS_WARN_RETAKE_FINGER;
    if (scores[1] >= .75)
        p.warnings |= DS_WARN_RETAKE_CURVED;
    if (scores[3] >= .75 && q.periodic > .05)
        p.warnings |= DS_WARN_MOIRE;
    if (scores[2] >= .85 && blur >= .7)
        p.warnings |= DS_WARN_RETAKE_BLUR;
    return p;
}
} // namespace docscan
