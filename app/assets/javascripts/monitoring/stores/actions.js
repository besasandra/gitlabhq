import * as Sentry from '@sentry/browser';
import * as types from './mutation_types';
import axios from '~/lib/utils/axios_utils';
import createFlash from '~/flash';
import { convertToFixedRange } from '~/lib/utils/datetime_range';
import { gqClient, parseEnvironmentsResponse, removeLeadingSlash } from './utils';
import trackDashboardLoad from '../monitoring_tracking_helper';
import getEnvironments from '../queries/getEnvironments.query.graphql';
import statusCodes from '../../lib/utils/http_status';
import { backOff, convertObjectPropsToCamelCase } from '../../lib/utils/common_utils';
import { s__, sprintf } from '../../locale';

import { PROMETHEUS_TIMEOUT } from '../constants';

function backOffRequest(makeRequestCallback) {
  return backOff((next, stop) => {
    makeRequestCallback()
      .then(resp => {
        if (resp.status === statusCodes.NO_CONTENT) {
          next();
        } else {
          stop(resp);
        }
      })
      .catch(stop);
  }, PROMETHEUS_TIMEOUT);
}

export const setGettingStartedEmptyState = ({ commit }) => {
  commit(types.SET_GETTING_STARTED_EMPTY_STATE);
};

export const setInitialState = ({ commit }, initialState) => {
  commit(types.SET_INITIAL_STATE, initialState);
};

export const setTimeRange = ({ commit }, timeRange) => {
  commit(types.SET_TIME_RANGE, timeRange);
};

export const filterEnvironments = ({ commit, dispatch }, searchTerm) => {
  commit(types.SET_ENVIRONMENTS_FILTER, searchTerm);
  dispatch('fetchEnvironmentsData');
};

export const setShowErrorBanner = ({ commit }, enabled) => {
  commit(types.SET_SHOW_ERROR_BANNER, enabled);
};

export const requestMetricsDashboard = ({ commit }) => {
  commit(types.REQUEST_METRICS_DATA);
};
export const receiveMetricsDashboardSuccess = ({ commit, dispatch }, { response, params }) => {
  const { all_dashboards, dashboard, metrics_data } = response;

  commit(types.SET_ALL_DASHBOARDS, all_dashboards);
  commit(types.RECEIVE_METRICS_DATA_SUCCESS, dashboard);
  commit(types.SET_ENDPOINTS, convertObjectPropsToCamelCase(metrics_data));

  return dispatch('fetchPrometheusMetrics', params);
};
export const receiveMetricsDashboardFailure = ({ commit }, error) => {
  commit(types.RECEIVE_METRICS_DATA_FAILURE, error);
};

export const receiveDeploymentsDataSuccess = ({ commit }, data) =>
  commit(types.RECEIVE_DEPLOYMENTS_DATA_SUCCESS, data);
export const receiveDeploymentsDataFailure = ({ commit }) =>
  commit(types.RECEIVE_DEPLOYMENTS_DATA_FAILURE);
export const requestEnvironmentsData = ({ commit }) => commit(types.REQUEST_ENVIRONMENTS_DATA);
export const receiveEnvironmentsDataSuccess = ({ commit }, data) =>
  commit(types.RECEIVE_ENVIRONMENTS_DATA_SUCCESS, data);
export const receiveEnvironmentsDataFailure = ({ commit }) =>
  commit(types.RECEIVE_ENVIRONMENTS_DATA_FAILURE);

export const fetchData = ({ dispatch }) => {
  dispatch('fetchDashboard');
  dispatch('fetchDeploymentsData');
  dispatch('fetchEnvironmentsData');
};

export const fetchDashboard = ({ state, commit, dispatch }) => {
  dispatch('requestMetricsDashboard');

  const params = {};

  if (state.timeRange) {
    const { start, end } = convertToFixedRange(state.timeRange);
    params.start_time = start;
    params.end_time = end;
  }

  if (state.currentDashboard) {
    params.dashboard = state.currentDashboard;
  }

  return backOffRequest(() => axios.get(state.dashboardEndpoint, { params }))
    .then(resp => resp.data)
    .then(response => dispatch('receiveMetricsDashboardSuccess', { response, params }))
    .catch(error => {
      Sentry.captureException(error);

      commit(types.SET_ALL_DASHBOARDS, error.response?.data?.all_dashboards ?? []);
      dispatch('receiveMetricsDashboardFailure', error);

      if (state.showErrorBanner) {
        if (error.response.data && error.response.data.message) {
          const { message } = error.response.data;
          createFlash(
            sprintf(
              s__('Metrics|There was an error while retrieving metrics. %{message}'),
              { message },
              false,
            ),
          );
        } else {
          createFlash(s__('Metrics|There was an error while retrieving metrics'));
        }
      }
    });
};

function fetchPrometheusResult(prometheusEndpoint, params) {
  return backOffRequest(() => axios.get(prometheusEndpoint, { params }))
    .then(res => res.data)
    .then(response => {
      if (response.status === 'error') {
        throw new Error(response.error);
      }

      return response.data.result;
    });
}

/**
 * Returns list of metrics in data.result
 * {"status":"success", "data":{"resultType":"matrix","result":[]}}
 *
 * @param {metric} metric
 */
export const fetchPrometheusMetric = ({ commit }, { metric, params }) => {
  const { start_time, end_time } = params;
  const timeDiff = (new Date(end_time) - new Date(start_time)) / 1000;

  const minStep = 60;
  const queryDataPoints = 600;
  const step = metric.step ? metric.step : Math.max(minStep, Math.ceil(timeDiff / queryDataPoints));

  const queryParams = {
    start_time,
    end_time,
    step,
  };

  commit(types.REQUEST_METRIC_RESULT, { metricId: metric.metricId });

  return fetchPrometheusResult(metric.prometheusEndpointPath, queryParams)
    .then(result => {
      commit(types.RECEIVE_METRIC_RESULT_SUCCESS, { metricId: metric.metricId, result });
    })
    .catch(error => {
      Sentry.captureException(error);

      commit(types.RECEIVE_METRIC_RESULT_FAILURE, { metricId: metric.metricId, error });
      // Continue to throw error so the dashboard can notify using createFlash
      throw error;
    });
};

export const fetchPrometheusMetrics = ({ state, commit, dispatch, getters }, params) => {
  commit(types.REQUEST_METRICS_DATA);

  const promises = [];
  state.dashboard.panelGroups.forEach(group => {
    group.panels.forEach(panel => {
      panel.metrics.forEach(metric => {
        promises.push(dispatch('fetchPrometheusMetric', { metric, params }));
      });
    });
  });

  return Promise.all(promises)
    .then(() => {
      const dashboardType = state.currentDashboard === '' ? 'default' : 'custom';
      trackDashboardLoad({
        label: `${dashboardType}_metrics_dashboard`,
        value: getters.metricsWithData().length,
      });
    })
    .catch(() => {
      createFlash(s__(`Metrics|There was an error while retrieving metrics`), 'warning');
    });
};

export const fetchDeploymentsData = ({ state, dispatch }) => {
  if (!state.deploymentsEndpoint) {
    return Promise.resolve([]);
  }
  return axios
    .get(state.deploymentsEndpoint)
    .then(resp => resp.data)
    .then(response => {
      if (!response || !response.deployments) {
        createFlash(s__('Metrics|Unexpected deployment data response from prometheus endpoint'));
      }

      dispatch('receiveDeploymentsDataSuccess', response.deployments);
    })
    .catch(error => {
      Sentry.captureException(error);
      dispatch('receiveDeploymentsDataFailure');
      createFlash(s__('Metrics|There was an error getting deployment information.'));
    });
};

export const fetchEnvironmentsData = ({ state, dispatch }) => {
  dispatch('requestEnvironmentsData');
  return gqClient
    .mutate({
      mutation: getEnvironments,
      variables: {
        projectPath: removeLeadingSlash(state.projectPath),
        search: state.environmentsSearchTerm,
      },
    })
    .then(resp =>
      parseEnvironmentsResponse(resp.data?.project?.data?.environments, state.projectPath),
    )
    .then(environments => {
      if (!environments) {
        createFlash(
          s__('Metrics|There was an error fetching the environments data, please try again'),
        );
      }

      dispatch('receiveEnvironmentsDataSuccess', environments);
    })
    .catch(err => {
      Sentry.captureException(err);
      dispatch('receiveEnvironmentsDataFailure');
      createFlash(s__('Metrics|There was an error getting environments information.'));
    });
};

/**
 * Set a new array of metrics to a panel group
 * @param {*} data An object containing
 *   - `key` with a unique panel key
 *   - `metrics` with the metrics array
 */
export const setPanelGroupMetrics = ({ commit }, data) => {
  commit(types.SET_PANEL_GROUP_METRICS, data);
};

export const duplicateSystemDashboard = ({ state }, payload) => {
  const params = {
    dashboard: payload.dashboard,
    file_name: payload.fileName,
    branch: payload.branch,
    commit_message: payload.commitMessage,
  };

  return axios
    .post(state.dashboardsEndpoint, params)
    .then(response => response.data)
    .then(data => data.dashboard)
    .catch(error => {
      Sentry.captureException(error);

      const { response } = error;

      if (response && response.data && response.data.error) {
        throw sprintf(s__('Metrics|There was an error creating the dashboard. %{error}'), {
          error: response.data.error,
        });
      } else {
        throw s__('Metrics|There was an error creating the dashboard.');
      }
    });
};

// prevent babel-plugin-rewire from generating an invalid default during karma tests
export default () => {};
