import React from 'react';
import styled from 'styled-components';
import PropTypes from 'prop-types';

import { Container as ContentContainer } from './Content';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: url('/statics/home-background-2.jpg') no-repeat center center,
    linear-gradient(
      45deg,
      rgba(51, 51, 51, 0.7) 30%,
      rgba(120, 120, 140, 0.5) 60%,
      rgba(253, 184, 19, 0.5) 90%
    );

  background-blend-mode: darken;
  background-size: cover;

  & ${ContentContainer} {
    position: relative;
    flex-grow: 1;
    height: calc(100% - 40px);
  }
`;

export default class App extends React.PureComponent {
  static propTypes = {
    children: PropTypes.oneOfType([
      PropTypes.arrayOf(PropTypes.node),
      PropTypes.node,
    ]).isRequired,
  };

  render() {
    return <Container>{this.props.children}</Container>;
  }
}
