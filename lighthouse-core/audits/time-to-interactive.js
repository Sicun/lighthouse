/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

'use strict';

const Audit = require('./audit');
const TracingProcessor = require('../lib/traces/tracing-processor');
const FMPMetric = require('./first-meaningful-paint');


// Parameters (in ms) for log-normal CDF scoring. To see the curve:
const SCORING_POINT_OF_DIMINISHING_RETURNS = 1700;
const SCORING_MEDIAN = 5000;

class TTIMetric extends Audit {
  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      category: 'Performance',
      name: 'time-to-interactive',
      description: 'Time To Interactive',
      optimalValue: 'TBD', // dunno what the scoring curve is yet...
      requiredArtifacts: ['traceContents', 'speedline']
    };
  }

  /**
   * Identify the time the page is "interactive"
   * @see https://docs.google.com/document/d/1oiy0_ych1v2ADhyG_QW7Ps4BNER2ShlJjx2zCbVzVyY/edit#
   *
   * The user thinks the page is ready - (They believe the page is done enough to start interacting with)
   *   - Layout has stabilized & key webfonts are visible.
   *     AKA: First meaningful paint has fired.
   *   - Page is nearly visually complete
   *     Visual completion is 85%
   *   - User-agent loading indicator is done
   *     Current definition: Top frame and all iframes have fired window load event
   *     Proposed definition (from cl/1860743002): top frame only: DCL ended and all layout-blocking resources, plus images that begun their request before DCL ended have finished.
   *     Alternative definition (from Chrome on Android Progress Bar Enhancements - google-only, sry): top frame's DOMContentLoaded + top frame's images (who started before DCL) are loaded
   *
   * The page is actually ready for user:
   *   - domContentLoadedEventEnd has fired
   *     Definition: HTML parsing has finished, all DOMContentLoaded handlers have run.
   *     No risk of DCL event handlers changing the page
   *     No surprises of inactive buttons/actions as DOM element event handlers should be bound
   *   - The main thread is available enough to handle user input
   *     first 500ms window where Est Input Latency is <50ms at the 90% percentile.
   * @param {!Artifacts} artifacts The artifacts from the gather phase.
   * @return {!AuditResult} The score from the audit, ranging from 0-100.
   */
  static audit(artifacts) {
    // We start looking at Math.Max(FMPMetric, visProgress[0.85])
    return FMPMetric.audit(artifacts).then(fmpResult => {
      if (fmpResult.value === -1) {
        return generateError(fmpResult.debugString);
      }
      const fmpTiming = parseFloat(fmpResult.rawValue);
      const timings = fmpResult.extendedInfo.timings;

      // Process the trace
      const tracingProcessor = new TracingProcessor();
      const model = tracingProcessor.init(artifacts.traceContents);
      const endOfTraceTime = model.bounds.max;

      // TODO: Wait for DOMContentLoadedEndEvent
      // TODO: Wait for UA loading indicator to be done

      // look at speedline results for 85% starting at FMP
      const visualProgress = artifacts.Speedline.frames.map(frame => {
        return {
          progress: frame.getProgress(),
          time: frame.getTimeStamp()
        };
      });
      const fMPts = timings.fMPfull + timings.navStart;
      const visuallyReady = visualProgress.find(frame => {
        return frame.time >= fMPts && frame.progress >= 85;
      });
      const visuallyReadyTiming = visuallyReady.time - timings.navStart;

      // Find first 500ms window where Est Input Latency is <50ms at the 90% percentile.
      let startTime = Math.max(fmpTiming, visuallyReadyTiming) - 50;
      let endTime;
      let currentLatency = Infinity;
      const percentile = 0.9;
      const threshold = 50;
      let foundLatencies = [];

      // When we've found a latency that's good enough, we're good.
      while (currentLatency > threshold) {
        // While latency is too high, increment just 50ms and look again.
        startTime += 50;
        endTime = startTime + 500;
        // If there's no more room in the trace to look, we're done.
        // TODO return an error instead
        if (endTime > endOfTraceTime) {
          return;
        }
        // Get our expected latency for the time window
        const latencies = TracingProcessor.getRiskToResponsiveness(
          model, artifacts.traceContents, startTime, endTime, [percentile]);
        const estLatency = latencies[0].time.toFixed(2);
        foundLatencies.push(Object.assign({}, {
          startTime: startTime.toFixed(1),
          estLatency
        }));
        // console.log('At', startTime.toFixed(2), '90 percentile est latency is ~', estLatency);
        // Grab this latency and try the threshold again
        currentLatency = estLatency;
      }
      const timeToInteractive = startTime.toFixed(1)

      // Use the CDF of a log-normal distribution for scoring.
      //   < 1200ms: score≈100
      //   5000ms: score=50
      //   >= 15000ms: score≈0
      const distribution = TracingProcessor.getLogNormalDistribution(SCORING_MEDIAN,
          SCORING_POINT_OF_DIMINISHING_RETURNS);
      let score = 100 * distribution.computeComplementaryPercentile(timeToInteractive);

      // Clamp the score to 0 <= x <= 100.
      score = Math.min(100, score);
      score = Math.max(0, score);
      score = Math.round(score);

      const extendedInfo = {
        timings: {
          fMP: fmpTiming.toFixed(1),
          visuallyReady: visuallyReadyTiming.toFixed(1),
          mainThreadAvail: startTime.toFixed(1)
        },
        expectedLatencyAtTTI: currentLatency,
        foundLatencies
      };
      // console.log('exendedInfo', extendedInfo);

      return TTIMetric.generateAuditResult({
        value: score,
        rawValue: `${timeToInteractive}ms`,
        optimalValue: this.meta.optimalValue,
        extendedInfo
      });
    }).catch(err => {
      return generateError(err);
    });
  }
}

module.exports = TTIMetric;


function generateError(err) {
  return TTIMetric.generateAuditResult({
    value: -1,
    rawValue: -1,
    optimalValue: TTIMetric.meta.optimalValue,
    debugString: err
  });
}