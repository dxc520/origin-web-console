'use strict';

angular.module("openshiftConsole")
  .factory("ImagesService", function($filter, ApplicationGenerator, DataService) {

    // maps an env object: { key: 'val', key2: 'val2'}
    // to an array: [{},{},{}]
    var makeEnvArray = function(input) {
      return _.isArray(input) ?
              input :
              _.map(input, function(value, key){
                return {name: key, value: value};
              });
    };

    var findImage = function(name, projectContext) {
      var importImage = {
        kind: "ImageStreamImport",
        apiVersion: "v1",
        metadata: {
          name: "newapp",
          namespace: projectContext.namespace
        },
        spec: {
          import: false,
          images: [{
            from: {
              kind: "DockerImage",
              name: name
            }
          }]
        },
        status: {}
      };

      return DataService.create('imagestreamimports',
                                null,
                                importImage,
                                projectContext).then(function(response) {
        return {
          name: _.get(response, 'spec.images[0].from.name'),
          image: _.get(response, 'status.images[0].image'),
          tag: _.get(response, 'status.images[0].tag'),
          // Call it "result" to avoid awkward "status.status" properties.
          result: _.get(response, 'status.images[0].status')
        };
      });
    };

    var runsAsRoot = function(image) {
      var user = _.get(image, 'dockerImageMetadata.Config.User');
      return !user ||
              user === '0' ||
              user === 'root';
    };

    var getVolumes = function(image) {
      return _.get(image, 'dockerImageMetadata.Config.Volumes');
    };

    // Generates resources for this Docker image, including
    //
    // - A deployment config
    // - A service
    // - An image stream (if not using an existing image stream tag)
    //
    // Creates emptyDir volumes for volumes declared in Docker image metadata.
    //
    // This is the same behavior as `oc new-app <image-name>`.
    //
    // Parameters:
    //
    // config, an object with the following required properties:
    //   name:         the "app" name
    //   image:        the image name (e.g., "mysql")
    //   tag:          the image tag (e.g., "latest")
    //   namspace:     the image stream namespace (if using an existing image stream tag)
    //   ports:        the image ports as specified in the Docker image metadata
    //   volumes:      the image volumes as specified in the Docker image metadata
    //   env:          environment vars
    //   labels:       labels for each resource
    //
    // Returns an array of objects that can be passed to `DataService.createList`
    var getResources = function(config) {
      var resources = [];

      var annotations = {
        "openshift.io/generated-by": "OpenShiftWebConsole"
      };

      // environment variables
      var env = makeEnvArray(config.env);

      // volumes and volume mounts
      var volumes = [], volumeMounts = [], volumeNumber = 0;
      _.forEach(config.volumes, function(value, path) {
        volumeNumber++;
        var volumeName = config.name + '-' + volumeNumber;
        volumes.push({
          name: volumeName,
          emptyDir: {}
        });
        volumeMounts.push({
          name: volumeName,
          mountPath: path
        });
      });

      if (!config.namespace) {
        var imageStream = {
          kind: "ImageStream",
          apiVersion: "v1",
          metadata: {
            name: config.name,
            labels: config.labels
          },
          spec: {
            tags: [{
              name: config.tag,
              annotations: _.assign({
                "openshift.io/imported-from": config.image
              }, annotations),
              from: {
                kind: "DockerImage",
                name: config.image
              },
              importPolicy: {}
            }]
          }
        };
        resources.push(imageStream);
      }

      var dcLabels = _.assign({
        deploymentconfig: config.name
      }, config.labels);

      var deploymentConfig = {
        kind: "DeploymentConfig",
        apiVersion: "v1",
        metadata: {
          name: config.name,
          labels: config.labels,
          annotations: annotations
        },
        spec: {
          strategy: {
            resources: {}
          },
          triggers: [{
            type: "ConfigChange"
          }, {
            type: "ImageChange",
            imageChangeParams: {
              automatic: true,
              containerNames: [
                config.name
              ],
              from: {
                kind: "ImageStreamTag",
                // If we created the ImageStream, use our name. Otherwise, use
                // the image name when referring to an ImageStreamTag from
                // another namespace.
                name: (config.namespace ? config.image : config.name) + ":" + config.tag,
                namespace: config.namespace
              }
            }
          }],
          replicas: 1,
          test: false,
          selector: dcLabels,
          template: {
            metadata: {
              labels: dcLabels,
              annotations: annotations
            },
            spec: {
              volumes: volumes,
              containers: [{
                name: config.name,
                image: config.image,
                ports: config.ports,
                env: env,
                volumeMounts: volumeMounts
              }],
              resources: {}
            }
          }
        },
        status: {}
      };

      resources.push(deploymentConfig);

      var service;
      if (!_.isEmpty(config.ports)) {
        service = {
          kind: "Service",
          apiVersion: "v1",
          metadata: {
            name: config.name,
            labels: config.labels,
            annotations: annotations
          },
          spec: {
            selector: {
              deploymentconfig: config.name
            },
            ports: _.map(config.ports, function(port) {
              return ApplicationGenerator.getServicePort(port);
            })
          }
        };
        resources.push(service);
      }

      return resources;
    };

    var getEnvironment = function(imageStreamImage) {
      return _.map(_.get(imageStreamImage, 'image.dockerImageMetadata.Config.Env'),
              function(entry) {
                var ind = entry.indexOf('=');
                var key = "";
                var value = "";
                if (ind > 0) {
                  key = entry.substring(0, ind);
                  if (ind + 1 < _.size(entry)) {
                    value = entry.substring(ind + 1);
                  }
                }
                else {
                  key = entry;
                }
                return {
                  name: key,
                  value: value
                };
              }
            );
    };

    return {
      findImage: findImage,
      getVolumes: getVolumes,
      runsAsRoot: runsAsRoot,
      getResources: getResources,
      getEnvironment: getEnvironment
    };
  });
