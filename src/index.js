var async = require('async');
var aws = require('aws-sdk');
var cwLogs = new aws.CloudWatchLogs();
var putMetrics = require('./put-metrics');

var options = {
    cloudWatchMetricNamespace: 'Lambda/ContainerMonitoring',
    lambdaFunctionPrefix: '/aws/lambda/'
};
var LOG_STREAM_ACTIVE_TIME_OFFSET_MILLIS = 10 * 60 * 1000;
exports.handler = handler;

handler({}, {
    done: function (error, result) {
        console.log(error || result);
    }
})
function handler(event, context) {
    getLambdaContainerStatistics(function (error, lambdaStatistics) {
        if (error) {
            return context.done(error);
        }
        putMetrics(options, lambdaStatistics, function (error) {
            if (error) {
                return context.done(error);
            }
            context.done(null, 'Done');
        });
    });
}

function getLambdaContainerStatistics(callback) {
    getAllLambdaLogGroups(null, null, function (error, logGroups) {
        addActiveLogStreamsToGroups(logGroups, function (error, logGroupsWithStreams) {
            var lambdaStatistics = [];
            for (var i = 0; i < logGroupsWithStreams.length; i++) {
                lambdaStatistics.push({
                    functionName: logGroupsWithStreams[i].logGroupName.replace('/aws/lambda/', ''),
                    activeContainers: logGroupsWithStreams[i].logStreams.length
                });
            }
            callback(error, lambdaStatistics);
        });
    });
}

function getAllLambdaLogGroups(logGroups, nextToken, callback) {
    logGroups = logGroups ? logGroups : [];
    var params = {
        logGroupNamePrefix: '/aws/lambda/'
    };
    if (nextToken) {
        params.nextToken = nextToken;
    }
    cwLogs.describeLogGroups(params, function (error, logGroupsResponse) {
        if (error) {
            return callback(error);
        }

        logGroups = logGroups.concat(logGroupsResponse.logGroups);
        if (logGroupsResponse.nextToken) {
            return getAllLambdaLogGroups(logGroups, logGroupsResponse.nextToken, callback);
        }
        callback(null, logGroups);
    });
}

function addActiveLogStreamsToGroups(logGroups, callback) {
    async.mapSeries(logGroups, function (logGroup, asyncCallback) {
        getActiveLogStreamsForGroup(logGroup, null, asyncCallback);
    }, function (error, logGroupsWithStreams) {
        callback(error, logGroupsWithStreams);
    });
}

function getActiveLogStreamsForGroup(logGroup, nextToken, callback) {
    logGroup.logStreams = logGroup.logStreams ? logGroup.logStreams : [];
    var params = {
        logGroupName: logGroup.logGroupName,
        descending: true,
        orderBy: 'LastEventTime'
    };
    if (nextToken) {
        params.nextToken = nextToken;
    }
    cwLogs.describeLogStreams(params, function (error, logStreamResponse) {
        if (error) {
            return callback(error);
        }

        var hasMore = !!logStreamResponse.nextToken;
        var lastActiveTimeAllowed = Date.now() - LOG_STREAM_ACTIVE_TIME_OFFSET_MILLIS;
        if (logStreamResponse.logStreams && logStreamResponse.logStreams.length > 0) {
            for (var i = 0; i < logStreamResponse.logStreams.length; i++) {
                if (logStreamResponse.logStreams[i].lastEventTimestamp > lastActiveTimeAllowed) {
                    logGroup.logStreams.push(logStreamResponse.logStreams[i]);
                } else {
                    // If we find a log stream that hasn't had recent activity we can stop looking
                    hasMore = false;
                    break;
                }
            }
        }

        if (hasMore) {
            return getActiveLogStreamsForGroup(logGroup, logStreamResponse.nextToken, callback);
        }
        callback(null, logGroup);
    });
}