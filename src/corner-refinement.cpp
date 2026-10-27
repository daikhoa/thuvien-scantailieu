#include "corner-refinement.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <opencv2/imgproc.hpp>

namespace docscan {
namespace {
constexpr int maximum_side = 768;
constexpr size_t maximum_lines = 240;
struct Line { cv::Point2d a, b; };
double cross(cv::Point2d a, cv::Point2d b) { return a.x * b.y - a.y * b.x; }
double edge_support(const cv::Mat &image, cv::Point2d a, cv::Point2d b) {
    const auto vector = b - a;
    const double length = cv::norm(vector);
    if (length < 3) return 0;
    const cv::Point2d normal{-vector.y * 3 / length, vector.x * 3 / length};
    double total = 0;
    for (int i = 0; i < 80; ++i) {
        const auto point = a + vector * (.06 + .88 * i / 79);
        const auto read = [&](cv::Point2d p) {
            return image.at<cv::Vec3b>(std::clamp(int(std::lround(p.y)), 0, image.rows - 1),
                                      std::clamp(int(std::lround(p.x)), 0, image.cols - 1));
        };
        const auto before = read(point - normal), after = read(point + normal);
        double difference = 0;
        for (int c = 0; c < 3; ++c) {
            const double d = double(before[c]) - after[c];
            difference += d * d;
        }
        total += std::min(100.0, std::sqrt(difference / 3));
    }
    return total / 80;
}
bool intersect(const Line &first, const Line &second, cv::Point2d &point) {
    const auto a = first.b - first.a, b = second.b - second.a;
    const double determinant = cross(a, b);
    if (std::abs(determinant) < 1e-8) return false;
    point = first.a + a * (cross(second.a - first.a, b) / determinant);
    return std::isfinite(point.x) && std::isfinite(point.y);
}
}

CornerRefinement refine_document_corners(const cv::Mat &source, const Quad &rough,
                                         const std::atomic<bool> &cancel) {
    check_cancel(cancel);
    require(!source.empty() && source.type() == CV_8UC3);
    for (const auto &p : rough)
        require(std::isfinite(p.x) && std::isfinite(p.y) &&
                std::abs(p.x) <= source.cols * 2.0 && std::abs(p.y) <= source.rows * 2.0);
    const double scale = std::min(1.0, double(maximum_side) / std::max(source.cols, source.rows));
    cv::Mat image;
    if (scale < 1)
        cv::resize(source, image, {}, scale, scale, cv::INTER_AREA);
    else image = source;
    const double sx = double(image.cols) / source.cols, sy = double(image.rows) / source.rows;
    Quad initial;
    for (size_t i = 0; i < 4; ++i) initial[i] = {rough[i].x * sx, rough[i].y * sy};
    cv::Mat gray, edges;
    cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
    cv::GaussianBlur(gray, gray, {3, 3}, 0);
    cv::Canny(gray, edges, 45, 120);
    check_cancel(cancel);
    std::vector<cv::Vec4i> segments;
    cv::HoughLinesP(edges, segments, 1, CV_PI / 360, 25, 25, 12);
    const auto squared_length = [](const cv::Vec4i &v) {
        const double x = double(v[2]) - v[0], y = double(v[3]) - v[1];
        return x * x + y * y;
    };
    std::sort(segments.begin(), segments.end(), [&](const auto &a, const auto &b) {
        return squared_length(a) > squared_length(b);
    });
    if (segments.size() > maximum_lines) segments.resize(maximum_lines);
    CornerRefinement best{rough, 0};
    // The other three corners can recover a single outlier. Edge evidence still
    // decides the result; this does not force a perspective document to be parallel.
    for (int hypothesis_index = -1; hypothesis_index < 4; ++hypothesis_index) {
        check_cancel(cancel);
        Quad hypothesis = initial;
        if (hypothesis_index >= 0) {
            const size_t i = size_t(hypothesis_index);
            hypothesis[i] = initial[(i + 3) % 4] + initial[(i + 1) % 4] - initial[(i + 2) % 4];
        }
        double shortest = std::numeric_limits<double>::infinity(), longest = 0;
        for (size_t i = 0; i < 4; ++i) {
            const double length = cv::norm(hypothesis[(i + 1) % 4] - hypothesis[i]);
            shortest = std::min(shortest, length); longest = std::max(longest, length);
        }
        if (shortest < 20 || longest > shortest * 3.5) continue;
        std::array<Line, 4> fitted;
        const double radius = std::max(8.0, std::min(45.0, shortest * .16));
        for (size_t i = 0; i < 4; ++i) {
            const auto a = hypothesis[i], b = hypothesis[(i + 1) % 4];
            const double length = cv::norm(b - a);
            const auto direction = (b - a) / length;
            fitted[i] = {a, b};
            double best_score = edge_support(image, a, b);
            for (const auto &segment : segments) {
                const cv::Point2d c{double(segment[0]), double(segment[1])},
                                  d{double(segment[2]), double(segment[3])};
                const auto unit = (d - c) / cv::norm(d - c);
                if (std::abs(direction.dot(unit)) < .94) continue;
                const double distance = std::abs(cross(unit, (a + b - c - d) * .5));
                if (distance > radius) continue;
                const double first = (c - a).dot(direction), second = (d - a).dot(direction);
                const double overlap = std::max(0.0, std::min(length, std::max(first, second)) -
                                                        std::max(0.0, std::min(first, second))) / length;
                if (overlap < .3) continue;
                const auto center = (a + b) * .5;
                const auto projected = center - cv::Point2d{-unit.y, unit.x} * cross(unit, center - c);
                const double score = edge_support(image, projected - unit * (length * .5),
                                                  projected + unit * (length * .5)) *
                                         (.65 + .35 * std::min(1.0, overlap)) - distance * .18;
                if (score > best_score) { best_score = score; fitted[i] = {c, d}; }
            }
        }
        Quad candidate;
        std::vector<cv::Point2f> contour;
        bool valid = true;
        for (size_t i = 0; i < 4; ++i) {
            if (!intersect(fitted[(i + 3) % 4], fitted[i], candidate[i]) ||
                candidate[i].x < 0 || candidate[i].y < 0 || candidate[i].x > image.cols ||
                candidate[i].y > image.rows || cv::norm(candidate[i] - hypothesis[i]) > longest * .35) {
                valid = false; break;
            }
            contour.emplace_back(float(candidate[i].x), float(candidate[i].y));
        }
        if (!valid || !cv::isContourConvex(contour)) continue;
        double total = 0, weakest = 100;
        for (size_t i = 0; i < 4; ++i) {
            const double support = edge_support(image, candidate[i], candidate[(i + 1) % 4]);
            total += support; weakest = std::min(weakest, support);
        }
        const double score = total / 4 * .7 + weakest * .3;
        if (score <= best.support) continue;
        best.support = score;
        for (size_t i = 0; i < 4; ++i) best.corners[i] = {candidate[i].x / sx, candidate[i].y / sy};
    }
    return best;
}

CornerAction corner_action(double confidence, double support) {
    require(std::isfinite(confidence) && confidence >= 0 && confidence <= 1 &&
            std::isfinite(support) && support >= 0 && support <= 100);
    if (confidence >= .5) return CornerAction::accept;
    return support >= minimum_corner_support ? CornerAction::verify : CornerAction::reject;
}

bool confirm_document_corners(const Quad &candidate, const Quad &confirmation, double confidence) {
    if (!std::isfinite(confidence) || confidence < .65 || confidence > 1) return false;
    std::vector<cv::Point2f> first, second, intersection;
    for (size_t i = 0; i < 4; ++i) {
        if (!std::isfinite(candidate[i].x) || !std::isfinite(candidate[i].y) ||
            !std::isfinite(confirmation[i].x) || !std::isfinite(confirmation[i].y)) return false;
        first.emplace_back(float(candidate[i].x), float(candidate[i].y));
        second.emplace_back(float(confirmation[i].x), float(confirmation[i].y));
    }
    if (!cv::isContourConvex(first) || !cv::isContourConvex(second)) return false;
    const double overlap = cv::intersectConvexConvex(first, second, intersection);
    const double total = std::abs(cv::contourArea(first)) + std::abs(cv::contourArea(second)) - overlap;
    return total > 0 && overlap / total >= .75;
}
}
